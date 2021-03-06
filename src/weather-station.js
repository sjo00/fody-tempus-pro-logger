const EventEmitter = require('events')
const noble = require('noble')
const Reading = require('./reading')
const Record = require('./record')

const COMPANY_ID = 0x4842

const SERVICE_UUID = 'fff0'

const SETTINGS_WRITE_CHARACTERISTIC_UUID = 'fff1'
const SETTINGS_NOTIFY_CHARACTERISTIC_UUID = 'fff2'
const WRITE_CHARACTERISTIC_UUID = 'fff3'
const NOTIFY_CHARACTERISTIC_UUID = 'fff4'

const getNormalizedAddresses = addresses => {
  return addresses && addresses.length > 0 && addresses.map(
    address => address.toLowerCase().replace(/:/g, '')
  )
}

class WeatherStation extends EventEmitter {
  static powerOn() {
    if (noble.state === 'poweredOn') {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        noble.removeListener('stateChange', stateChangeHandler)
        reject(new Error('Timeout while waiting for power on (state: ' + noble.state + ')'))
      }, 5000)

      const stateChangeHandler = state => {
        if (state === 'poweredOn') {
          clearTimeout(timeout)
          noble.removeListener('stateChange', stateChangeHandler)
          resolve()
        }
      }

      noble.on('stateChange', stateChangeHandler)
    })
  }

  static scan(discoverHandler, addresses = null) {
    return WeatherStation.powerOn().then(() => {
      return new Promise((resolve, reject) => {
        const stations = []

        const _discoverHandler = peripheral => {
          const address = peripheral.address && peripheral.address.replace(/:/g, '')
          if (addresses && addresses.indexOf(address) === -1) {
            return
          }

          const station = new WeatherStation(peripheral)
          stations.push(station)

          if (discoverHandler) {
            discoverHandler.call(this, station)
          }
        }

        const scanStopHandler = () => {
          noble.removeListener('discover', _discoverHandler)
          noble.removeListener('scanStop', scanStopHandler)
          noble.removeListener('stateChange', stateChangeHandler)
          resolve(stations)
        }

        const stateChangeHandler = state => {
          if (state !== 'poweredOn') {
            noble.removeListener('discover', _discoverHandler)
            noble.removeListener('scanStop', scanStopHandler)
            noble.removeListener('stateChange', stateChangeHandler)
            noble.stopScanning()
            reject(new Error('State changed to ' + state))
          }
        }

        noble.startScanning([SERVICE_UUID], false, error => {
          if (error) {
            reject(error)
            return
          }

          noble.on('discover', _discoverHandler)
          noble.on('scanStop', scanStopHandler)
          noble.on('stateChange', stateChangeHandler)
        })
      })
    })
  }

  static scanForReadings(readingHandler, addresses = null) {
    return WeatherStation.powerOn().then(() => {
      return new Promise((resolve, reject) => {
        const discoverHandler = peripheral => {
          const data = peripheral.advertisement.manufacturerData
          if (data.length < 9 || data.readUInt16LE(0) !== COMPANY_ID) {
            return
          }

          const address = peripheral.address && peripheral.address.replace(/:/g, '')
          if (address && data.readUIntLE(2, 6).toString(16) !== address) {
            // Seems like the advertisement data always starts with the address
            // in little endian, so we use that as an additional check here
            return
          }

          if (addresses && addresses.indexOf(address) === -1) {
            return
          }

          if (readingHandler) {
            for (const reading of Reading.parseReadings(data.slice(8))) {
              readingHandler.call(this, reading, peripheral)
            }
          }
        }

        const scanStopHandler = () => {
          noble.removeListener('discover', discoverHandler)
          noble.removeListener('scanStop', scanStopHandler)
          noble.removeListener('stateChange', stateChangeHandler)
          resolve()
        }

        const stateChangeHandler = state => {
          if (state !== 'poweredOn') {
            noble.removeListener('discover', discoverHandler)
            noble.removeListener('scanStop', scanStopHandler)
            noble.removeListener('stateChange', stateChangeHandler)
            noble.stopScanning()
            reject(new Error('State changed to ' + state))
          }
        }

        noble.startScanning([SERVICE_UUID], true, error => {
          if (error) {
            reject(error)
            return
          }

          noble.on('discover', discoverHandler)
          noble.on('scanStop', scanStopHandler)
          noble.on('stateChange', stateChangeHandler)
        })
      })
    })
  }

  static stopScan() {
    return new Promise((resolve, reject) => {
      noble.stopScanning(() => {
        resolve()
      })
    })
  }

  static getRecord(includedReadings, readTimeout = 10000, addresses = null) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log('Timed out while listening for sensor readings')
        WeatherStation.stopScan()
      }, readTimeout)

      const record = new Record()

      const readingHandler = reading => {
        if (includedReadings.indexOf(reading.name) !== -1) {
          record.add(reading)

          if (record.size >= includedReadings.length) {
            clearTimeout(timeout)
            WeatherStation.stopScan()
          }
        }
      }

      WeatherStation.scanForReadings(
        readingHandler,
        getNormalizedAddresses(addresses)
      )
        .then(() => {
          clearTimeout(timeout)
          resolve(record)
        })
        .catch(error => {
          clearTimeout(timeout)
          reject(error)
        })
    })
  }

  constructor(peripheral) {
    super()
    this.peripheral = peripheral
    this.id = peripheral.id
    this.address = peripheral.address
    this.localName = peripheral.advertisement.localName
  }

  connect() {
    this.emit('connecting')

    return new Promise((resolve, reject) => {
      if (this.peripheral.state === 'connected') {
        resolve()
        return
      }

      this.peripheral.connect(error => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    }).then(() => {
      return this._getCharacteristics()
    }).then(() => {
      return this._setupListeners()
    }).then(() => {
      return this._initialize()
    }).then(() => {
      this.emit('connected')
    })
  }

  _getCharacteristics() {
    return new Promise((resolve, reject) => {
      const disconnectHandler = () => {
        reject(new Error('Peripheral disconnected unexpectedly'))
      }
      this.peripheral.once('disconnect', disconnectHandler)

      this.peripheral.discoverSomeServicesAndCharacteristics(
        [SERVICE_UUID],
        [],
        (error, services, characteristics) => {
          this.peripheral.removeListener('disconnect', disconnectHandler)

          if (error) {
            reject(error)
          } else {
            this.settingsWriteCharacteristic = characteristics.find(
              c => c.uuid === SETTINGS_WRITE_CHARACTERISTIC_UUID
            )
            this.settingsNotifyCharacteristic = characteristics.find(
              c => c.uuid === SETTINGS_NOTIFY_CHARACTERISTIC_UUID
            )
            this.writeCharacteristic = characteristics.find(
              c => c.uuid === WRITE_CHARACTERISTIC_UUID
            )
            this.notifyCharacteristic = characteristics.find(
              c => c.uuid === NOTIFY_CHARACTERISTIC_UUID
            )

            resolve()
          }
        }
      )
    })
  }

  _setupListeners() {
    return new Promise((resolve, reject) => {
      const disconnectHandler = () => {
        reject(new Error('Peripheral disconnected unexpectedly'))
      }
      this.peripheral.once('disconnect', disconnectHandler)

      this.settingsNotifyCharacteristic.subscribe(error => {
        if (error) {
          this.peripheral.removeListener('disconnect', disconnectHandler)
          reject(error)
        } else {
          this.notifyCharacteristic.subscribe(error2 => {
            this.peripheral.removeListener('disconnect', disconnectHandler)
            if (error2) {
              reject(error2)
            } else {
              resolve()
            }
          })
        }
      })
    })
  }

  _initialize() {
    return new Promise((resolve, reject) => {
      const disconnectHandler = () => {
        reject(new Error('Peripheral disconnected unexpectedly'))
      }
      this.peripheral.once('disconnect', disconnectHandler)

      // Not sure was this does...
      this.writeSetting(Buffer.from([0x6, 0x6, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30]), 0x80)
        // Not sure was this does...
        .then(this.writeSetting(Buffer.from([0x5, 0x6, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30]), 0x80))
        // Not sure was this does...
        .then(this.writeSetting(Buffer.from([0xaa, 0x2, 0x33, 0xff]), 0x80))
        .then(() => {
          this.peripheral.removeListener('disconnect', disconnectHandler)
          resolve()
        })
        .catch(error => {
          this.peripheral.removeListener('disconnect', disconnectHandler)
          reject(error)
        })
    })
  }

  writeSetting(data, responseCommand) {
    return this._write(
      this.settingsWriteCharacteristic,
      this.settingsNotifyCharacteristic,
      data,
      responseCommand
    )
  }

  write(data, responseCommand) {
    return this._write(
      this.writeCharacteristic,
      this.notifyCharacteristic,
      data,
      responseCommand
    )
  }

  _write(writeCharacteristic, notifyCharacteristic, data, responseCommand) {
    return new Promise((resolve, reject) => {
      const dataHandler = (receivedData, isNotification) => {
        if (isNotification && receivedData.readUInt8(0) === responseCommand) {
          notifyCharacteristic.removeListener('data', dataHandler)
          resolve(receivedData)
        }
      }
      notifyCharacteristic.on('data', dataHandler)

      writeCharacteristic.write(data, false, error => {
        this.emit('write', data, error)
        if (error) {
          notifyCharacteristic.removeListener('data', dataHandler)
          reject(error)
        }
      })
    })
  }
}

module.exports = WeatherStation
