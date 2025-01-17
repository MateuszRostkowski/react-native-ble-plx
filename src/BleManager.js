// @flow
'use strict'

import type {
    Base64,
    BleManagerOptions,
    ConnectionOptions,
    DeviceId,
    Identifier,
    ScanOptions,
    Subscription,
    TransactionId,
    UUID
} from './TypeDefinition'
import {
    BleATTErrorCode,
    BleAndroidErrorCode,
    BleError,
    BleErrorCode,
    BleErrorCodeMessage,
    BleIOSErrorCode,
    parseBleError
} from './BleError'
import { type BleErrorCodeMessageMapping, ConnectionPriority, LogLevel, State } from './TypeDefinition'
import { BleModule, EventEmitter } from './BleModule'
import type { NativeBleRestoredState, NativeCharacteristic, NativeDescriptor, NativeDevice } from './BleModule'
import { decode, encode } from 'js-base64'

import { Characteristic } from './Characteristic'
import { Descriptor } from './Descriptor'
import { Device } from './Device'
import { Service } from './Service'
import base64 from 'react-native-base64'
import moment from 'moment'

// Scale Write Characteristic
const scaleWriteCharacteristic = '0000fff3-0000-1000-8000-00805f9b34fb'

// Scale Read Characteristic
const scaleReadCharacteristic = '0000fff4-0000-1000-8000-00805f9b34fb'

// Alternative Scale Read Characteristic
const alternativeScaleReadCharacteristic = '0000fff3-0000-1000-8000-00805f9b34fb'

// Alternative Scale Final Read Characteristic
const alternativeScaleReadFinalCharacteristic = '0000fff1-0000-1000-8000-00805f9b34fb'

// Alternative Scale Write Characteristic
const alternativeScaleWriteCharacteristic = '0000fff2-0000-1000-8000-00805f9b34fb'

// Tracker Write Characteristic
const trackerWriteCharacteristic = '0000fff6-0000-1000-8000-00805f9b34fb'

// Tracker Read Characteristic
const trackerReadCharacteristic = '0000fff7-0000-1000-8000-00805f9b34fb'

// Tracker Service UUID
const trackerServiceUUID = '0000fff0-0000-1000-8000-00805f9b34fb'

// Scale Service UUID
const scaleServiceUUID = '0000fff0-0000-1000-8000-00805f9b34fb'

const bloodPressureServiceUUID = '000018f0-0000-1000-8000-00805f9b34fb'
const bloodPressureCharacteristicUUID = '00002af0-0000-1000-8000-00805f9b34fb'
const bloodPressureCharacteristicWriteUUID = '00002af1-0000-1000-8000-00805f9b34fb'

const oximeterServiceUUID = 'cdeacb80-5235-4c07-8846-93a37ee6b86d'
const oximeterCharacteristicNotifyUUID = 'cdeacb81-5235-4c07-8846-93a37ee6b86d'
const oximeterCharacteristicWriteUUID = 'cdeacb82-5235-4c07-8846-93a37ee6b86d'

const glucometerServiceUUID = '00001000-0000-1000-8000-00805f9b34fb'
const glucometerCharacteristicReadUUID = '00001002-0000-1000-8000-00805f9b34fb'
const glucometerCharacteristicWriteUUID = '00001001-0000-1000-8000-00805f9b34fb'

/**
 *
 * BleManager is an entry point for react-native-ble-plx library. It provides all means to discover and work with
 * {@link Device} instances. It should be initialized only once with `new` keyword and method
 * {@link #blemanagerdestroy|destroy()} should be called on its instance when user wants to deallocate all resources.
 *
 * In case you want to properly support Background Mode, you should provide `restoreStateIdentifier` and
 * `restoreStateFunction` in {@link BleManagerOptions}.
 *
 * @example
 * const manager = new BleManager();
 * // ... work with BLE manager ...
 * manager.destroy();
 */
export class BleManager {
    // Scan subscriptions
    _scanEventSubscription: ? EventEmitter
        // Listening to BleModule events
    _eventEmitter: EventEmitter
        // Unique identifier used to create internal transactionIds
    _uniqueId: number
        // Map of active promises with functions to forcibly cancel them
    _activePromises: {
            [id: string]: (error: BleError) => void
        }
        // Map of active subscriptions
    _activeSubscriptions: {
        [id: string]: Subscription
    }

    // Map of error codes to error messages
    _errorCodesToMessagesMapping: BleErrorCodeMessageMapping

    /**
     * Creates an instance of {@link BleManager}.
     */
    constructor(options: BleManagerOptions = {}) {
        this._eventEmitter = new EventEmitter(BleModule)
        this._uniqueId = 0
        this._activePromises = {}
        this._activeSubscriptions = {}

        const restoreStateFunction = options.restoreStateFunction
        if (restoreStateFunction != null && options.restoreStateIdentifier != null) {
            this._activeSubscriptions[this._nextUniqueID()] = this._eventEmitter.addListener(
                BleModule.RestoreStateEvent,
                (nativeRestoredState: NativeBleRestoredState) => {
                    if (nativeRestoredState == null) {
                        restoreStateFunction(null)
                        return
                    }
                    restoreStateFunction({
                        connectedPeripherals: nativeRestoredState.connectedPeripherals.map(
                            nativeDevice => new Device(nativeDevice, this)
                        )
                    })
                }
            )
        }

        this._errorCodesToMessagesMapping = options.errorCodesToMessagesMapping ?
            options.errorCodesToMessagesMapping :
            BleErrorCodeMessage

        BleModule.createClient(options.restoreStateIdentifier || null)
    }

    /**
     * Destroys all promises which are in progress.
     * @private
     */
    _destroyPromises() {
        const destroyedError = new BleError({
                errorCode: BleErrorCode.BluetoothManagerDestroyed,
                attErrorCode: (null: ? $Values < typeof BleATTErrorCode > ),
                iosErrorCode: (null: ? $Values < typeof BleIOSErrorCode > ),
                androidErrorCode: (null: ? $Values < typeof BleAndroidErrorCode > ),
                reason: (null: ? string)
            },
            this._errorCodesToMessagesMapping
        )
        for (const id in this._activePromises) {
            this._activePromises[id](destroyedError)
        }
    }

    /**
     * Destroys all subscriptions.
     * @private
     */
    _destroySubscriptions() {
        for (const id in this._activeSubscriptions) {
            this._activeSubscriptions[id].remove()
        }
    }

    calculateChecksum(array) {
        let i = 0
        let sum = 0

        for (; i < array.length; i++) {
            sum += array[i]
        }

        return sum & 0xff
    }

    base64ArrayBuffer(arrayBuffer) {
        var base64 = ''
        var encodings = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

        var bytes = new Uint8Array(arrayBuffer)
        var byteLength = bytes.byteLength
        var byteRemainder = byteLength % 3
        var mainLength = byteLength - byteRemainder

        var a, b, c, d
        var chunk

        // Main loop deals with bytes in chunks of 3
        for (var i = 0; i < mainLength; i = i + 3) {
            // Combine the three bytes into a single integer
            chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]

            // Use bitmasks to extract 6-bit segments from the triplet
            a = (chunk & 16515072) >> 18 // 16515072 = (2^6 - 1) << 18
            b = (chunk & 258048) >> 12 // 258048   = (2^6 - 1) << 12
            c = (chunk & 4032) >> 6 // 4032     = (2^6 - 1) << 6
            d = chunk & 63 // 63       = 2^6 - 1

            // Convert the raw binary segments to the appropriate ASCII encoding
            base64 += encodings[a] + encodings[b] + encodings[c] + encodings[d]
        }

        // Deal with the remaining bytes and padding
        if (byteRemainder == 1) {
            chunk = bytes[mainLength]

            a = (chunk & 252) >> 2 // 252 = (2^6 - 1) << 2

            // Set the 4 least significant bits to zero
            b = (chunk & 3) << 4 // 3   = 2^2 - 1

            base64 += encodings[a] + encodings[b] + '=='
        } else if (byteRemainder == 2) {
            chunk = (bytes[mainLength] << 8) | bytes[mainLength + 1]

            a = (chunk & 64512) >> 10 // 64512 = (2^6 - 1) << 10
            b = (chunk & 1008) >> 4 // 1008  = (2^6 - 1) << 4

            // Set the 2 least significant bits to zero
            c = (chunk & 15) << 2 // 15    = 2^4 - 1

            base64 += encodings[a] + encodings[b] + encodings[c] + '='
        }

        return base64
    }

    /**
     * Destroys {@link BleManager} instance. A new instance needs to be created to continue working with
     * this library. All operations which were in progress completes with
     * {@link #bleerrorcodebluetoothmanagerdestroyed|BluetoothManagerDestroyed} error code.
     */
    destroy() {
        // Destroy native module object
        BleModule.destroyClient()

        // Unsubscribe from any subscriptions
        if (this._scanEventSubscription != null) {
            this._scanEventSubscription.remove()
            this._scanEventSubscription = null
        }
        this._destroySubscriptions()

        // Destroy all promises
        this._destroyPromises()
    }

    /**
     * Generates new unique identifier to be used internally.
     *
     * @returns {string} New identifier.
     * @private
     */
    _nextUniqueID(): string {
        this._uniqueId += 1
        return this._uniqueId.toString()
    }

    /**
     * Calls promise and checks if it completed successfully
     *
     * @param {Promise<T>} promise Promise to be called
     * @returns {Promise<T>} Value of called promise.
     * @private
     */
    async _callPromise < T > (promise: Promise < T > ): Promise < T > {
        const id = this._nextUniqueID()
        try {
            const destroyPromise = new Promise((resolve, reject) => {
                this._activePromises[id] = reject
            })
            const value = await Promise.race([destroyPromise, promise])
            delete this._activePromises[id]
            return value
        } catch (error) {
            delete this._activePromises[id]
            throw parseBleError(error.message, this._errorCodesToMessagesMapping)
        }
    }

    // Mark: Common ------------------------------------------------------------------------------------------------------

    /**
     * Sets new log level for native module's logging mechanism.
     * @param {LogLevel} logLevel New log level to be set.
     */
    setLogLevel(logLevel: $Keys < typeof LogLevel > ) {
        BleModule.setLogLevel(logLevel)
    }

    /**
     * Get current log level for native module's logging mechanism.
     * @returns {Promise<LogLevel>} Current log level.
     */
    logLevel(): Promise < $Keys < typeof LogLevel >> {
        return this._callPromise(BleModule.logLevel())
    }

    /**
     * Cancels pending transaction.
     *
     * Few operations such as monitoring characteristic's value changes can be cancelled by a user. Basically every API
     * entry which accepts `transactionId` allows to call `cancelTransaction` function. When cancelled operation is a
     * promise or a callback which registers errors, {@link #bleerror|BleError} with error code
     * {@link #bleerrorcodeoperationcancelled|OperationCancelled} will be emitted in that case. Cancelling transaction
     * which doesn't exist is ignored.
     *
     * @example
     * const transactionId = 'monitor_battery';
     *
     * // Monitor battery notifications
     * manager.monitorCharacteristicForDevice(
     *   device.id, '180F', '2A19',
     *   (error, characteristic) => {
     *   // Handle battery level changes...
     * }, transactionId);
     *
     * // Cancel after specified amount of time
     * setTimeout(() => manager.cancelTransaction(transactionId), 2000);
     *
     * @param {TransactionId} transactionId Id of pending transactions.
     */
    cancelTransaction(transactionId: TransactionId) {
        BleModule.cancelTransaction(transactionId)
    }

    // Mark: Monitoring state --------------------------------------------------------------------------------------------

    /**
     * Enable Bluetooth. This function blocks until BLE is in PoweredOn state. [Android only]
     *
     * @param {?TransactionId} transactionId Transaction handle used to cancel operation
     * @returns {Promise<BleManager>} Promise completes when state transition was successful.
     */
    async enable(transactionId: ? TransactionId): Promise < BleManager > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        await this._callPromise(BleModule.enable(transactionId))
        return this
    }

    /**
     * Disable Bluetooth. This function blocks until BLE is in PoweredOff state. [Android only]
     *
     * @param {?TransactionId} transactionId Transaction handle used to cancel operation
     * @returns {Promise<BleManager>} Promise completes when state transition was successful.
     */
    async disable(transactionId: ? TransactionId): Promise < BleManager > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        await this._callPromise(BleModule.disable(transactionId))
        return this
    }

    /**
     * Current, global {@link State} of a {@link BleManager}. All APIs are working only when active state
     * is "PoweredOn".
     *
     * @returns {Promise<State>} Promise which emits current state of BleManager.
     */
    state(): Promise < $Keys < typeof State >> {
        return this._callPromise(BleModule.state())
    }

    /**
     * Notifies about {@link State} changes of a {@link BleManager}.
     *
     * @example
     * const subscription = this.manager.onStateChange((state) => {
     *      if (state === 'PoweredOn') {
     *          this.scanAndConnect();
     *          subscription.remove();
     *      }
     *  }, true);
     *
     * @param {function(newState: State)} listener Callback which emits state changes of BLE Manager.
     * Look at {@link State} for possible values.
     * @param {boolean} [emitCurrentState=false] If true, current state will be emitted as well. Defaults to false.
     *
     * @returns {Subscription} Subscription on which `remove()` function can be called to unsubscribe.
     */
    onStateChange(listener: (newState: $Keys < typeof State > ) => void, emitCurrentState: boolean = false): Subscription {
        const subscription: Subscription = this._eventEmitter.addListener(BleModule.StateChangeEvent, listener)
        const id = this._nextUniqueID()
        var wrappedSubscription: Subscription

        if (emitCurrentState) {
            var cancelled = false
            this._callPromise(this.state()).then(currentState => {
                if (!cancelled) {
                    listener(currentState)
                }
            })

            wrappedSubscription = {
                remove: () => {
                    if (this._activeSubscriptions[id] != null) {
                        cancelled = true
                        delete this._activeSubscriptions[id]
                        subscription.remove()
                    }
                }
            }
        } else {
            wrappedSubscription = {
                remove: () => {
                    if (this._activeSubscriptions[id] != null) {
                        delete this._activeSubscriptions[id]
                        subscription.remove()
                    }
                }
            }
        }

        this._activeSubscriptions[id] = wrappedSubscription
        return wrappedSubscription
    }

    // Mark: Scanning ----------------------------------------------------------------------------------------------------

    /**
     * Starts device scanning. When previous scan is in progress it will be stopped before executing this command.
     *
     * @param {?Array<UUID>} UUIDs Array of strings containing {@link UUID}s of {@link Service}s which are registered in
     * scanned {@link Device}. If `null` is passed, all available {@link Device}s will be scanned.
     * @param {?ScanOptions} options Optional configuration for scanning operation.
     * @param {function(error: ?BleError, scannedDevice: ?Device)} listener Function which will be called for every scanned
     * {@link Device} (devices may be scanned multiple times). It's first argument is potential {@link Error} which is set
     * to non `null` value when scanning failed. You have to start scanning process again if that happens. Second argument
     * is a scanned {@link Device}.
     */
    startDeviceScan(
        UUIDs: ? Array < UUID > ,
        options : ? ScanOptions,
        listener : (error: ? BleError, scannedDevice : ? Device) => void
    ) {
        this.stopDeviceScan()
        const scanListener = ([error, nativeDevice]: [ ? string, ? NativeDevice]) => {
                listener(
                    error ? parseBleError(error, this._errorCodesToMessagesMapping) : null,
                    nativeDevice ? new Device(nativeDevice, this) : null
                )
            }
            // $FlowFixMe: Flow cannot deduce EmitterSubscription type.
        this._scanEventSubscription = this._eventEmitter.addListener(BleModule.ScanEvent, scanListener)
        BleModule.startDeviceScan(UUIDs, options)
    }

    /**
     * Stops {@link Device} scan if in progress.
     */
    stopDeviceScan() {
        if (this._scanEventSubscription != null) {
            this._scanEventSubscription.remove()
            this._scanEventSubscription = null
        }
        BleModule.stopDeviceScan()
    }

    /**
     * Request a connection parameter update. This functions may update connection parameters on Android API level 21 or
     * above.
     *
     * @param {DeviceId} deviceIdentifier Device identifier.
     * @param {ConnectionPriority} connectionPriority: Connection priority.
     * @param {?TransactionId} transactionId Transaction handle used to cancel operation.
     * @returns {Promise<Device>} Connected device.
     */
    async requestConnectionPriorityForDevice(
        deviceIdentifier: DeviceId,
        connectionPriority: $Values < typeof ConnectionPriority > ,
        transactionId: ? TransactionId
    ): Promise < Device > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeDevice = await this._callPromise(
            BleModule.requestConnectionPriorityForDevice(deviceIdentifier, connectionPriority, transactionId)
        )
        return new Device(nativeDevice, this)
    }

    /**
     * Reads RSSI for connected device.
     *
     * @param {DeviceId} deviceIdentifier Device identifier.
     * @param {?TransactionId} transactionId Transaction handle used to cancel operation
     * @returns {Promise<Device>} Connected device with updated RSSI value.
     */
    async readRSSIForDevice(deviceIdentifier: DeviceId, transactionId: ? TransactionId): Promise < Device > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeDevice = await this._callPromise(BleModule.readRSSIForDevice(deviceIdentifier, transactionId))
        return new Device(nativeDevice, this)
    }

    /**
     * Request new MTU value for this device. This function currently is not doing anything
     * on iOS platform as MTU exchange is done automatically.
     * @param {DeviceId} deviceIdentifier Device identifier.
     * @param {number} mtu New MTU to negotiate.
     * @param {?TransactionId} transactionId Transaction handle used to cancel operation
     * @returns {Promise<Device>} Device with updated MTU size. Default value is 23.
     */
    async requestMTUForDevice(deviceIdentifier: DeviceId, mtu: number, transactionId: ? TransactionId): Promise < Device > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeDevice = await this._callPromise(BleModule.requestMTUForDevice(deviceIdentifier, mtu, transactionId))
        return new Device(nativeDevice, this)
    }

    // Mark: Connection management ---------------------------------------------------------------------------------------

    /**
     * Returns a list of known devices by their identifiers.
     * @param {Array<DeviceId>} deviceIdentifiers List of device identifiers.
     * @returns {Promise<Array<Device>>} List of known devices by their identifiers.
     */
    async devices(deviceIdentifiers: Array < DeviceId > ): Promise < Array < Device >> {
        const nativeDevices = await this._callPromise(BleModule.devices(deviceIdentifiers))
        return nativeDevices.map((nativeDevice: NativeDevice) => {
            return new Device(nativeDevice, this)
        })
    }

    /**
     * Returns a list of the peripherals (containing any of the specified services) currently connected to the system
     * which have discovered services. Returned devices **may not be connected** to your application. Make sure to check
     * if that's the case with function {@link #blemanagerisdeviceconnected|isDeviceConnected}.
     * @param {Array<UUID>} serviceUUIDs List of service UUIDs. Device must contain at least one of them to be listed.
     * @returns {Promise<Array<Device>>} List of known devices with discovered services as stated in the parameter.
     */
    async connectedDevices(serviceUUIDs: Array < UUID > ): Promise < Array < Device >> {
        const nativeDevices = await this._callPromise(BleModule.connectedDevices(serviceUUIDs))
        return nativeDevices.map((nativeDevice: NativeDevice) => {
            return new Device(nativeDevice, this)
        })
    }

    // Mark: Connection management ---------------------------------------------------------------------------------------

    /**
     * Connects to {@link Device} with provided ID.
     *
     * @param {DeviceId} deviceIdentifier {@link Device} identifier.
     * @param {?ConnectionOptions} options Platform specific options for connection establishment.
     * @returns {Promise<Device>} Connected {@link Device} object if successful.
     */
    async connectToDevice(deviceIdentifier: DeviceId, options: ? ConnectionOptions): Promise < Device > {
        const nativeDevice = await this._callPromise(BleModule.connectToDevice(deviceIdentifier, options))
        return new Device(nativeDevice, this)
    }

    /**
     * Disconnects from {@link Device} if it's connected or cancels pending connection.
     *
     * @param {DeviceId} deviceIdentifier {@link Device} identifier to be closed.
     * @returns {Promise<Device>} Returns closed {@link Device} when operation is successful.
     */
    async cancelDeviceConnection(deviceIdentifier: DeviceId): Promise < Device > {
        const nativeDevice = await this._callPromise(BleModule.cancelDeviceConnection(deviceIdentifier))
        return new Device(nativeDevice, this)
    }

    /**
     * Monitors if {@link Device} was disconnected due to any errors or connection problems.
     *
     * @param {DeviceId} deviceIdentifier {@link Device} identifier to be monitored.
     * @param {function(error: ?BleError, device: Device)} listener - callback returning error as a reason of disconnection
     * if available and {@link Device} object. If an error is null, that means the connection was terminated by
     * {@link #blemanagercanceldeviceconnection|bleManager.cancelDeviceConnection()} call.
     * @returns {Subscription} Subscription on which `remove()` function can be called to unsubscribe.
     */
    onDeviceDisconnected(deviceIdentifier: DeviceId, listener: (error: ? BleError, device : Device) => void): Subscription {
        const disconnectionListener = ([error, nativeDevice]: [ ? string, NativeDevice]) => {
            if (deviceIdentifier !== nativeDevice.id) return
            listener(error ? parseBleError(error, this._errorCodesToMessagesMapping) : null, new Device(nativeDevice, this))
        }

        const subscription: Subscription = this._eventEmitter.addListener(
            BleModule.DisconnectionEvent,
            disconnectionListener
        )

        const id = this._nextUniqueID()
        const wrappedSubscription = {
            remove: () => {
                if (this._activeSubscriptions[id] != null) {
                    delete this._activeSubscriptions[id]
                    subscription.remove()
                }
            }
        }
        this._activeSubscriptions[id] = wrappedSubscription
        return wrappedSubscription
    }

    /**
     * Check connection state of a {@link Device}.
     *
     * @param {DeviceId} deviceIdentifier {@link Device} identifier.
     * @returns {Promise<boolean>} Promise which emits `true` if device is connected, and `false` otherwise.
     */
    isDeviceConnected(deviceIdentifier: DeviceId): Promise < boolean > {
        return this._callPromise(BleModule.isDeviceConnected(deviceIdentifier))
    }

    // Mark: Discovery ---------------------------------------------------------------------------------------------------

    /**
     * Discovers all {@link Service}s,  {@link Characteristic}s and {@link Descriptor}s for {@link Device}.
     *
     * @param {DeviceId} deviceIdentifier {@link Device} identifier.
     * @param {?TransactionId} transactionId Transaction handle used to cancel operation
     * @returns {Promise<Device>} Promise which emits {@link Device} object if all available services and
     * characteristics have been discovered.
     */
    async discoverAllServicesAndCharacteristicsForDevice(
        deviceIdentifier: DeviceId,
        transactionId: ? TransactionId
    ): Promise < Device > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeDevice = await this._callPromise(
            BleModule.discoverAllServicesAndCharacteristicsForDevice(deviceIdentifier, transactionId)
        )
        return new Device(nativeDevice, this)
    }

    // Mark: Service and characteristic getters --------------------------------------------------------------------------

    /**
     * List of discovered {@link Service}s for {@link Device}.
     *
     * @param {DeviceId} deviceIdentifier {@link Device} identifier.
     * @returns {Promise<Array<Service>>} Promise which emits array of {@link Service} objects which are discovered for a
     * {@link Device}.
     */
    async servicesForDevice(deviceIdentifier: DeviceId): Promise < Array < Service >> {
        const services = await this._callPromise(BleModule.servicesForDevice(deviceIdentifier))
        return services.map(nativeService => {
            return new Service(nativeService, this)
        })
    }

    /**
     * List of discovered {@link Characteristic}s for given {@link Device} and {@link Service}.
     *
     * @param {DeviceId} deviceIdentifier {@link Device} identifier.
     * @param {UUID} serviceUUID {@link Service} UUID.
     * @returns {Promise<Array<Characteristic>>} Promise which emits array of {@link Characteristic} objects which are
     * discovered for a {@link Device} in specified {@link Service}.
     */
    characteristicsForDevice(deviceIdentifier: DeviceId, serviceUUID: UUID): Promise < Array < Characteristic >> {
        return this._handleCharacteristics(BleModule.characteristicsForDevice(deviceIdentifier, serviceUUID))
    }

    /**
     * List of discovered {@link Characteristic}s for unique {@link Service}.
     *
     * @param {Identifier} serviceIdentifier {@link Service} ID.
     * @returns {Promise<Array<Characteristic>>} Promise which emits array of {@link Characteristic} objects which are
     * discovered in unique {@link Service}.
     * @private
     */
    _characteristicsForService(serviceIdentifier: Identifier): Promise < Array < Characteristic >> {
        return this._handleCharacteristics(BleModule.characteristicsForService(serviceIdentifier))
    }

    /**
     * Common code for handling NativeCharacteristic fetches.
     *
     * @param {Promise<Array<NativeCharacteristic>>} characteristicsPromise Native characteristics.
     * @returns {Promise<Array<Characteristic>>} Promise which emits array of {@link Characteristic} objects which are
     * discovered in unique {@link Service}.
     * @private
     */
    async _handleCharacteristics(
        characteristicsPromise: Promise < Array < NativeCharacteristic >>
    ): Promise < Array < Characteristic >> {
        const characteristics = await this._callPromise(characteristicsPromise)
        return characteristics.map(nativeCharacteristic => {
            return new Characteristic(nativeCharacteristic, this)
        })
    }

    /**
     * List of discovered {@link Descriptor}s for given {@link Device}, {@link Service} and {@link Characteristic}.
     *
     * @param {DeviceId} deviceIdentifier {@link Device} identifier.
     * @param {UUID} serviceUUID {@link Service} UUID.
     * @param {UUID} characteristicUUID {@link Characteristic} UUID.
     * @returns {Promise<Array<Descriptor>>} Promise which emits array of {@link Descriptor} objects which are
     * discovered for a {@link Device}, {@link Service} in specified {@link Characteristic}.
     */
    descriptorsForDevice(
        deviceIdentifier: DeviceId,
        serviceUUID: UUID,
        characteristicUUID: UUID
    ): Promise < Array < Descriptor >> {
        return this._handleDescriptors(BleModule.descriptorsForDevice(deviceIdentifier, serviceUUID, characteristicUUID))
    }

    /**
     * List of discovered {@link Descriptor}s for given {@link Service} and {@link Characteristic}.
     *
     * @param {Identifier} serviceIdentifier {@link Service} identifier.
     * @param {UUID} characteristicUUID {@link Characteristic} UUID.
     * @returns {Promise<Array<Descriptor>>} Promise which emits array of {@link Descriptor} objects which are
     * discovered for a {@link Service} in specified {@link Characteristic}.
     * @private
     */
    _descriptorsForService(serviceIdentifier: Identifier, characteristicUUID: UUID): Promise < Array < Descriptor >> {
        return this._handleDescriptors(BleModule.descriptorsForService(serviceIdentifier, characteristicUUID))
    }

    /**
     * List of discovered {@link Descriptor}s for given {@link Characteristic}.
     *
     * @param {Identifier} characteristicIdentifier {@link Characteristic} identifier.
     * @returns {Promise<Array<Descriptor>>} Promise which emits array of {@link Descriptor} objects which are
     * discovered in specified {@link Characteristic}.
     * @private
     */
    _descriptorsForCharacteristic(characteristicIdentifier: Identifier): Promise < Array < Descriptor >> {
        return this._handleDescriptors(BleModule.descriptorsForCharacteristic(characteristicIdentifier))
    }

    /**
     *  Common code for handling NativeDescriptor fetches.
     * @param {Promise<Array<NativeDescriptor>>} descriptorsPromise Native descriptors.
     * @returns {Promise<Array<Descriptor>>} Promise which emits array of {@link Descriptor} objects which are
     * discovered in unique {@link Characteristic}.
     * @private
     */
    async _handleDescriptors(descriptorsPromise: Promise < Array < NativeDescriptor >> ): Promise < Array < Descriptor >> {
        const descriptors = await this._callPromise(descriptorsPromise)
        return descriptors.map(nativeDescriptor => {
            return new Descriptor(nativeDescriptor, this)
        })
    }

    // Mark: Characteristics operations ----------------------------------------------------------------------------------

    /**
     * Read {@link Characteristic} value.
     *
     * @param {DeviceId} deviceIdentifier {@link Device} identifier.
     * @param {UUID} serviceUUID {@link Service} UUID.
     * @param {UUID} characteristicUUID {@link Characteristic} UUID.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Promise<Characteristic>} Promise which emits first {@link Characteristic} object matching specified
     * UUID paths. Latest value of {@link Characteristic} will be stored inside returned object.
     */
    async readCharacteristicForDevice(
        deviceIdentifier: DeviceId,
        serviceUUID: UUID,
        characteristicUUID: UUID,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeCharacteristic = await this._callPromise(
            BleModule.readCharacteristicForDevice(deviceIdentifier, serviceUUID, characteristicUUID, transactionId)
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    /**
     * Read {@link Characteristic} value.
     *
     * @param {Identifier} serviceIdentifier {@link Service} ID.
     * @param {UUID} characteristicUUID {@link Characteristic} UUID.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Promise<Characteristic>} Promise which emits first {@link Characteristic} object matching specified
     * UUID paths. Latest value of {@link Characteristic} will be stored inside returned object.
     * @private
     */
    async _readCharacteristicForService(
        serviceIdentifier: Identifier,
        characteristicUUID: UUID,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeCharacteristic = await this._callPromise(
            BleModule.readCharacteristicForService(serviceIdentifier, characteristicUUID, transactionId)
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    /**
     * Read {@link Characteristic} value.
     *
     * @param {Identifier} characteristicIdentifier {@link Characteristic} ID.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Promise<Characteristic>} Promise which emits first {@link Characteristic} object matching specified ID.
     * Latest value of {@link Characteristic} will be stored inside returned object.
     * @private
     */
    async _readCharacteristic(
        characteristicIdentifier: Identifier,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeCharacteristic = await this._callPromise(
            BleModule.readCharacteristic(characteristicIdentifier, transactionId)
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    /**
     * Write {@link Characteristic} value with response.
     *
     * @param {DeviceId} deviceIdentifier {@link Device} identifier.
     * @param {UUID} serviceUUID {@link Service} UUID.
     * @param {UUID} characteristicUUID {@link Characteristic} UUID.
     * @param {Base64} base64Value Value in Base64 format.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Promise<Characteristic>} Promise which emits first {@link Characteristic} object matching specified
     * UUID paths. Latest value of characteristic may not be stored inside returned object.
     */
    async writeCharacteristicWithResponseForDevice(
        deviceIdentifier: DeviceId,
        serviceUUID: UUID,
        characteristicUUID: UUID,
        base64Value: Base64,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                serviceUUID,
                characteristicUUID,
                base64Value,
                true,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    async setUserProfileToAlternativeScale(
        deviceIdentifier: DeviceId,
        user: string,
        age: number,
        height: number,
        gender: number,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        const heightUnit = height < 100 ? 100 : height > 218 ? 218 : height
        const ageUnit = (age = age < 10 ? 10 : age > 98 ? 98 : age)

        var uint16 = new Uint8Array(13)
        uint16[0] = 0x81
        uint16[1] = 0x00
        uint16[2] = 0x81
        uint16[3] = parseInt(user.slice(0, 2), 16)
        uint16[4] = parseInt(user.slice(2, 4), 16)
        uint16[5] = parseInt(user.slice(4, 6), 16)
        uint16[6] = parseInt(user.slice(6, 8), 16)
        uint16[7] = 0x00
        uint16[8] = parseInt(heightUnit)
        uint16[9] = parseInt(ageUnit)
        uint16[10] = parseInt(gender)
        uint16[11] = 0x00
        uint16[12] = 0x00

        const value = this.base64ArrayBuffer(uint16)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                scaleServiceUUID,
                alternativeScaleWriteCharacteristic,
                value,
                false,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    async synchronizeAlternativeScale(
        deviceIdentifier: DeviceId,
        user: string,
        measurement: string,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        const measurementUnit = measurement === 'metric' ? 0 : 1

        var uint16 = new Uint8Array(13)
        uint16[0] = 0x41
        uint16[1] = 0x00
        uint16[2] = 0x84
        uint16[3] = parseInt(user.slice(0, 2), 16)
        uint16[4] = parseInt(user.slice(2, 4), 16)
        uint16[5] = parseInt(user.slice(4, 6), 16)
        uint16[6] = parseInt(user.slice(6, 8), 16)
        uint16[7] = parseInt(measurementUnit, 16)

        const value = this.base64ArrayBuffer(uint16)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                scaleServiceUUID,
                alternativeScaleWriteCharacteristic,
                value,
                false,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    async selectProfileAlternativeScale(
        deviceIdentifier: DeviceId,
        user: string,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        const measurementUnit = measurementUnit === 'metric' ? 0 : 1

        var uint16 = new Uint8Array(13)
        uint16[0] = 0x41
        uint16[1] = 0x00
        uint16[2] = 0x82
        uint16[3] = parseInt(user.slice(0, 2), 16)
        uint16[4] = parseInt(user.slice(2, 4), 16)
        uint16[5] = parseInt(user.slice(4, 6), 16)
        uint16[6] = parseInt(user.slice(6, 8), 16)

        const value = this.base64ArrayBuffer(uint16)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                scaleServiceUUID,
                alternativeScaleWriteCharacteristic,
                value,
                false,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    async resetAlternativeScale(deviceIdentifier: DeviceId, transactionId: ? TransactionId): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        const measurementUnit = measurementUnit === 'metric' ? 0 : 1

        var uint16 = new Uint8Array([0x01])

        const value = this.base64ArrayBuffer(uint16)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                scaleServiceUUID,
                alternativeScaleReadFinalCharacteristic,
                value,
                true,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    async activateVibration(
        deviceIdentifier: DeviceId,
        duration: number,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        const durationUnit = duration > 10 ? 10 : duration

        var uint16 = new Uint8Array(16)
        uint16[0] = 0x36
        uint16[1] = durationUnit

        uint16[15] = this.calculateChecksum(uint16)
        const value = this.base64ArrayBuffer(uint16)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                trackerServiceUUID,
                trackerWriteCharacteristic,
                value,
                true,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    async setDeviceTime(
        deviceIdentifier: DeviceId,
        date: string,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        var uint16 = new Uint8Array(16)
        uint16[0] = 0x01
        uint16[1] = parseInt(date.slice(2, 4), 16)
        uint16[2] = parseInt(date.slice(5, 7), 16)
        uint16[3] = parseInt(date.slice(8, 10), 16)
        uint16[4] = parseInt(date.slice(11, 13), 16)
        uint16[5] = parseInt(date.slice(14, 16), 16)
        uint16[6] = parseInt(date.slice(17, 19), 16)
        uint16[15] = this.calculateChecksum(uint16)

        const value = this.base64ArrayBuffer(uint16)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                trackerServiceUUID,
                trackerWriteCharacteristic,
                value,
                true,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    async setTrackerDistanceUnit(
        deviceIdentifier: DeviceId,
        unit: string,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        const measurementType = unit === 'us' ? 0x01 : 0x00

        var uint16 = new Uint8Array(16)
        uint16[0] = 0x0f
        uint16[1] = measurementType
        uint16[15] = this.calculateChecksum(uint16)

        const value = this.base64ArrayBuffer(uint16)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                trackerServiceUUID,
                trackerWriteCharacteristic,
                value,
                true,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    async getDetailedDayActivity(
        deviceIdentifier: DeviceId,
        date: number,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        var uint16 = new Uint8Array(16)
        uint16[0] = 0x43
        uint16[1] = date
        uint16[15] = this.calculateChecksum(uint16)

        const value = this.base64ArrayBuffer(uint16)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                trackerServiceUUID,
                trackerWriteCharacteristic,
                value,
                true,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    async getSummaryDayActivity(
        deviceIdentifier: DeviceId,
        date: number,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        var uint16 = new Uint8Array(16)
        uint16[0] = 0x07
        uint16[1] = date
        uint16[15] = this.calculateChecksum(uint16)

        const value = this.base64ArrayBuffer(uint16)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                trackerServiceUUID,
                trackerWriteCharacteristic,
                value,
                true,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    /**
     * Write {@link Characteristic} value with response.
     *
     * @param {Identifier} serviceIdentifier {@link Service} ID.
     * @param {UUID} characteristicUUID {@link Characteristic} UUID.
     * @param {Base64} base64Value Value in Base64 format.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Promise<Characteristic>} Promise which emits first {@link Characteristic} object matching specified
     * UUID paths. Latest value of characteristic may not be stored inside returned object.
     * @private
     */
    async _writeCharacteristicWithResponseForService(
        serviceIdentifier: Identifier,
        characteristicUUID: UUID,
        base64Value: Base64,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForService(serviceIdentifier, characteristicUUID, base64Value, true, transactionId)
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    /**
     * Write {@link Characteristic} value with response.
     *
     * @param {Identifier} characteristicIdentifier {@link Characteristic} ID.
     * @param {Base64} base64Value Value in Base64 format.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Promise<Characteristic>} Promise which emits first {@link Characteristic} object matching specified ID.
     * Latest value of characteristic may not be stored inside returned object.
     * @private
     */
    async _writeCharacteristicWithResponse(
        characteristicIdentifier: Identifier,
        base64Value: Base64,
        transactionId: ? TransactionId
    ) {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristic(characteristicIdentifier, base64Value, true, transactionId)
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    /**
     * Write {@link Characteristic} value without response.
     *
     * @param {DeviceId} deviceIdentifier {@link Device} identifier.
     * @param {UUID} serviceUUID {@link Service} UUID.
     * @param {UUID} characteristicUUID {@link Characteristic} UUID.
     * @param {Base64} base64Value Value in Base64 format.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Promise<Characteristic>} Promise which emits first {@link Characteristic} object matching specified
     * UUID paths. Latest value of characteristic may not be stored inside returned object.
     */
    async writeCharacteristicWithoutResponseForDevice(
        deviceIdentifier: DeviceId,
        serviceUUID: UUID,
        characteristicUUID: UUID,
        base64Value: Base64,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                serviceUUID,
                characteristicUUID,
                base64Value,
                false,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    /**
     * Write {@link Characteristic} value without response.
     *
     * @param {Identifier} serviceIdentifier {@link Service} ID.
     * @param {UUID} characteristicUUID {@link Characteristic} UUID.
     * @param {Base64} base64Value Value in Base64 format.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Promise<Characteristic>} Promise which emits first {@link Characteristic} object matching specified
     * UUID paths. Latest value of characteristic may not be stored inside returned object.
     * @private
     */
    async _writeCharacteristicWithoutResponseForService(
        serviceIdentifier: Identifier,
        characteristicUUID: UUID,
        base64Value: Base64,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForService(serviceIdentifier, characteristicUUID, base64Value, false, transactionId)
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    /**
     * Write {@link Characteristic} value without response.
     *
     * @param {Identifier} characteristicIdentifier {@link Characteristic} UUID.
     * @param {Base64} base64Value Value in Base64 format.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Promise<Characteristic>} Promise which emits first {@link Characteristic} object matching specified ID.
     * Latest value of characteristic may not be stored inside returned object.
     * @private
     */
    async _writeCharacteristicWithoutResponse(
        characteristicIdentifier: Identifier,
        base64Value: Base64,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristic(characteristicIdentifier, base64Value, false, transactionId)
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    /**
     * Monitor value changes of a {@link Characteristic}. If notifications are enabled they will be used
     * in favour of indications.
     *
     * @param {DeviceId} deviceIdentifier {@link Device} identifier.
     * @param {UUID} serviceUUID {@link Service} UUID.
     * @param {UUID} characteristicUUID {@link Characteristic} UUID.
     * @param {function(error: ?BleError, characteristic: ?Characteristic)} listener - callback which emits
     * {@link Characteristic} objects with modified value for each notification.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Subscription} Subscription on which `remove()` function can be called to unsubscribe.
     */
    monitorCharacteristicForDevice(
        deviceIdentifier: DeviceId,
        serviceUUID: UUID,
        characteristicUUID: UUID,
        listener: (error: ? BleError, characteristic : ? Characteristic) => void,
        transactionId: ? TransactionId
    ): Subscription {
        const filledTransactionId = transactionId || this._nextUniqueID()
        return this._handleMonitorCharacteristic(
            BleModule.monitorCharacteristicForDevice(deviceIdentifier, serviceUUID, characteristicUUID, filledTransactionId),
            filledTransactionId,
            listener
        )
    }

    monitorScaleResponse(
        deviceIdentifier: DeviceId,
        listener: (error: ? BleError, characteristic : ? Characteristic) => void,
        transactionId: ? TransactionId
    ): Subscription {
        const filledTransactionId = transactionId || this._nextUniqueID()
        return this._handleMonitorCharacteristic(
            BleModule.monitorCharacteristicForDevice(
                deviceIdentifier,
                scaleServiceUUID,
                scaleReadCharacteristic,
                filledTransactionId
            ),
            filledTransactionId,
            listener
        )
    }

    monitorAlternativeScaleFinalResponse(
        deviceIdentifier: DeviceId,
        listener: (error: ? BleError, characteristic : ? Characteristic) => void,
        transactionId: ? TransactionId
    ): Subscription {
        const filledTransactionId = transactionId || this._nextUniqueID()
        return this._handleMonitorCharacteristic(
            BleModule.monitorCharacteristicForDevice(
                deviceIdentifier,
                scaleServiceUUID,
                alternativeScaleReadFinalCharacteristic,
                filledTransactionId
            ),
            filledTransactionId,
            listener
        )
    }

    listenForAlternativeScaleResponse(
        deviceIdentifier: DeviceId,
        listener: (error: ? BleError, characteristic : ? Characteristic) => void,
        transactionId: ? TransactionId
    ): Subscription {
        const filledTransactionId = transactionId || this._nextUniqueID()
        return this._handleMonitorCharacteristic(
            BleModule.monitorCharacteristicForDevice(
                deviceIdentifier,
                scaleServiceUUID,
                alternativeScaleReadCharacteristic,
                filledTransactionId
            ),
            filledTransactionId,
            listener
        )
    }

    monitorTrackerResponse(
        deviceIdentifier: DeviceId,
        listener: (error: ? BleError, characteristic : ? Characteristic) => void,
        transactionId: ? TransactionId
    ): Subscription {
        const filledTransactionId = transactionId || this._nextUniqueID()
        return this._handleMonitorCharacteristic(
            BleModule.monitorCharacteristicForDevice(
                deviceIdentifier,
                trackerServiceUUID,
                trackerReadCharacteristic,
                filledTransactionId
            ),
            filledTransactionId,
            listener
        )
    }

    /**
     * Monitor value changes of a {@link Characteristic}. If notifications are enabled they will be used
     * in favour of indications.
     *
     * @param {Identifier} serviceIdentifier {@link Service} ID.
     * @param {UUID} characteristicUUID {@link Characteristic} UUID.
     * @param {function(error: ?BleError, characteristic: ?Characteristic)} listener - callback which emits
     * {@link Characteristic} objects with modified value for each notification.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Subscription} Subscription on which `remove()` function can be called to unsubscribe.
     * @private
     */
    _monitorCharacteristicForService(
        serviceIdentifier: Identifier,
        characteristicUUID: UUID,
        listener: (error: ? BleError, characteristic : ? Characteristic) => void,
        transactionId: ? TransactionId
    ): Subscription {
        const filledTransactionId = transactionId || this._nextUniqueID()
        return this._handleMonitorCharacteristic(
            BleModule.monitorCharacteristicForService(serviceIdentifier, characteristicUUID, filledTransactionId),
            filledTransactionId,
            listener
        )
    }

    /**
     * Monitor value changes of a {@link Characteristic}. If notifications are enabled they will be used
     * in favour of indications.
     *
     * @param {Identifier} characteristicIdentifier - {@link Characteristic} ID.
     * @param {function(error: ?BleError, characteristic: ?Characteristic)} listener - callback which emits
     * {@link Characteristic} objects with modified value for each notification.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Subscription} Subscription on which `remove()` function can be called to unsubscribe.
     * @private
     */
    _monitorCharacteristic(
        characteristicIdentifier: Identifier,
        listener: (error: ? BleError, characteristic : ? Characteristic) => void,
        transactionId: ? TransactionId
    ): Subscription {
        const filledTransactionId = transactionId || this._nextUniqueID()
        return this._handleMonitorCharacteristic(
            BleModule.monitorCharacteristic(characteristicIdentifier, filledTransactionId),
            filledTransactionId,
            listener
        )
    }

    /**
     * Common code to handle characteristic monitoring.
     *
     * @param {Promise<void>} monitorPromise Characteristic monitoring promise
     * @param {TransactionId} transactionId TransactionId of passed promise
     * @param {function(error: ?BleError, characteristic: ?Characteristic)} listener - callback which emits
     * {@link Characteristic} objects with modified value for each notification.
     * @returns {Subscription} Subscription on which `remove()` function can be called to unsubscribe.
     * @private
     */
    _handleMonitorCharacteristic(
        monitorPromise: Promise < void > ,
        transactionId: TransactionId,
        listener: (error: ? BleError, characteristic : ? Characteristic) => void
    ): Subscription {
        const monitorListener = ([error, characteristic, msgTransactionId]: [ ?
            string,
            NativeCharacteristic,
            TransactionId
        ]) => {
            if (transactionId !== msgTransactionId) return
            if (error) {
                listener(parseBleError(error, this._errorCodesToMessagesMapping), null)
                return
            }
            listener(null, new Characteristic(characteristic, this))
        }

        const subscription: Subscription = this._eventEmitter.addListener(BleModule.ReadEvent, monitorListener)

        const id = this._nextUniqueID()
        const wrappedSubscription: Subscription = {
            remove: () => {
                if (this._activeSubscriptions[id] != null) {
                    delete this._activeSubscriptions[id]
                    subscription.remove()
                }
            }
        }
        this._activeSubscriptions[id] = wrappedSubscription

        this._callPromise(monitorPromise).then(
            () => {
                wrappedSubscription.remove()
            },
            (error: BleError) => {
                listener(error, null)
                wrappedSubscription.remove()
            }
        )

        return {
            remove: () => {
                BleModule.cancelTransaction(transactionId)
            }
        }
    }

    // Mark: Descriptors operations ----------------------------------------------------------------------------------

    /**
     * Read {@link Descriptor} value.
     *
     * @param {DeviceId} deviceIdentifier {@link Device} identifier.
     * @param {UUID} serviceUUID {@link Service} UUID.
     * @param {UUID} characteristicUUID {@link Characteristic} UUID.
     * @param {UUID} descriptorUUID {@link Descriptor} UUID.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Promise<Descriptor>} Promise which emits first {@link Descriptor} object matching specified
     * UUID paths. Latest value of {@link Descriptor} will be stored inside returned object.
     */
    async readDescriptorForDevice(
        deviceIdentifier: DeviceId,
        serviceUUID: UUID,
        characteristicUUID: UUID,
        descriptorUUID: UUID,
        transactionId: ? TransactionId
    ): Promise < Descriptor > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeDescriptor = await this._callPromise(
            BleModule.readDescriptorForDevice(
                deviceIdentifier,
                serviceUUID,
                characteristicUUID,
                descriptorUUID,
                transactionId
            )
        )
        return new Descriptor(nativeDescriptor, this)
    }

    /**
     * Read {@link Descriptor} value.
     *
     * @param {Identifier} serviceIdentifier {@link Service} identifier.
     * @param {UUID} characteristicUUID {@link Characteristic} UUID.
     * @param {UUID} descriptorUUID {@link Descriptor} UUID.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Promise<Descriptor>} Promise which emits first {@link Descriptor} object matching specified
     * UUID paths. Latest value of {@link Descriptor} will be stored inside returned object.
     * @private
     */
    async _readDescriptorForService(
        serviceIdentifier: Identifier,
        characteristicUUID: UUID,
        descriptorUUID: UUID,
        transactionId: ? TransactionId
    ): Promise < Descriptor > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeDescriptor = await this._callPromise(
            BleModule.readDescriptorForService(serviceIdentifier, characteristicUUID, descriptorUUID, transactionId)
        )
        return new Descriptor(nativeDescriptor, this)
    }

    /**
     * Read {@link Descriptor} value.
     *
     * @param {Identifier} characteristicIdentifier {@link Characteristic} identifier.
     * @param {UUID} descriptorUUID {@link Descriptor} UUID.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Promise<Descriptor>} Promise which emits first {@link Descriptor} object matching specified
     * UUID paths. Latest value of {@link Descriptor} will be stored inside returned object.
     * @private
     */
    async _readDescriptorForCharacteristic(
        characteristicIdentifier: Identifier,
        descriptorUUID: UUID,
        transactionId: ? TransactionId
    ): Promise < Descriptor > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeDescriptor = await this._callPromise(
            BleModule.readDescriptorForCharacteristic(characteristicIdentifier, descriptorUUID, transactionId)
        )
        return new Descriptor(nativeDescriptor, this)
    }

    /**
     * Read {@link Descriptor} value.
     *
     * @param {Identifier} descriptorIdentifier {@link Descriptor} identifier.
     * @param {?TransactionId} transactionId optional `transactionId` which can be used in
     * {@link #blemanagercanceltransaction|cancelTransaction()} function.
     * @returns {Promise<Descriptor>} Promise which emits first {@link Descriptor} object matching specified
     * UUID paths. Latest value of {@link Descriptor} will be stored inside returned object.
     * @private
     */
    async _readDescriptor(descriptorIdentifier: Identifier, transactionId: ? TransactionId): Promise < Descriptor > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeDescriptor = await this._callPromise(BleModule.readDescriptor(descriptorIdentifier, transactionId))
        return new Descriptor(nativeDescriptor, this)
    }

    /**
     * Write {@link Descriptor} value.
     *
     * @param {DeviceId} deviceIdentifier Connected device identifier
     * @param {UUID} serviceUUID Service UUID
     * @param {UUID} characteristicUUID Characteristic UUID
     * @param {UUID} descriptorUUID Descriptor UUID
     * @param {Base64} valueBase64 Value to be set coded in Base64
     * @param {?TransactionId} transactionId Transaction handle used to cancel operation
     * @returns {Promise<Descriptor>} Descriptor which saved passed value
     */
    async writeDescriptorForDevice(
        deviceIdentifier: DeviceId,
        serviceUUID: UUID,
        characteristicUUID: UUID,
        descriptorUUID: UUID,
        valueBase64: Base64,
        transactionId: ? TransactionId
    ): Promise < Descriptor > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeDescriptor = await this._callPromise(
            BleModule.writeDescriptorForDevice(
                deviceIdentifier,
                serviceUUID,
                characteristicUUID,
                descriptorUUID,
                valueBase64,
                transactionId
            )
        )
        return new Descriptor(nativeDescriptor, this)
    }

    /**
     * Write {@link Descriptor} value.
     *
     * @param {Identifier} serviceIdentifier Service identifier
     * @param {UUID} characteristicUUID Characteristic UUID
     * @param {UUID} descriptorUUID Descriptor UUID
     * @param {Base64} valueBase64 Value to be set coded in Base64
     * @param {?TransactionId} transactionId Transaction handle used to cancel operation
     * @returns {Promise<Descriptor>} Descriptor which saved passed value
     * @private
     */
    async _writeDescriptorForService(
        serviceIdentifier: Identifier,
        characteristicUUID: UUID,
        descriptorUUID: UUID,
        valueBase64: Base64,
        transactionId: ? TransactionId
    ): Promise < Descriptor > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeDescriptor = await this._callPromise(
            BleModule.writeDescriptorForService(
                serviceIdentifier,
                characteristicUUID,
                descriptorUUID,
                valueBase64,
                transactionId
            )
        )
        return new Descriptor(nativeDescriptor, this)
    }

    /**
     * Write {@link Descriptor} value.
     *
     * @param {Identifier} characteristicIdentifier Characteristic identifier
     * @param {UUID} descriptorUUID Descriptor UUID
     * @param {Base64} valueBase64 Value to be set coded in Base64
     * @param {?TransactionId} transactionId Transaction handle used to cancel operation
     * @returns {Promise<Descriptor>} Descriptor which saved passed value
     * @private
     */
    async _writeDescriptorForCharacteristic(
        characteristicIdentifier: Identifier,
        descriptorUUID: UUID,
        valueBase64: Base64,
        transactionId: ? TransactionId
    ): Promise < Descriptor > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeDescriptor = await this._callPromise(
            BleModule.writeDescriptorForCharacteristic(characteristicIdentifier, descriptorUUID, valueBase64, transactionId)
        )
        return new Descriptor(nativeDescriptor, this)
    }

    async setUserProfileToScales(
        deviceIdentifier: DeviceId,
        age: number,
        height: number,
        gender: string,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const ageUnit = age < 10 ? 10 : age > 98 ? 98 : age
        const genderUnit = gender === 'male' ? age + 128 : age
        const heightUnit = height < 100 ? 100 : height > 218 ? 218 : height
        var array = new Uint16Array([0xfd, 0x53, 0x00, 0x00, 0xff, genderUnit, heightUnit])

        const value = this.base64ArrayBuffer(array)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(deviceIdentifier, 'fff0', 'fff3', value, false, transactionId)
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    /**
     * Write {@link Descriptor} value.
     *
     * @param {Identifier} descriptorIdentifier Descriptor identifier
     * @param {Base64} valueBase64 Value to be set coded in Base64
     * @param {?TransactionId} transactionId Transaction handle used to cancel operation
     * @returns {Promise<Descriptor>} Descriptor which saved passed value
     * @private
     */
    async _writeDescriptor(
        descriptorIdentifier: Identifier,
        valueBase64: Base64,
        transactionId: ? TransactionId
    ): Promise < Descriptor > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }
        const nativeDescriptor = await this._callPromise(
            BleModule.writeDescriptor(descriptorIdentifier, valueBase64, transactionId)
        )
        return new Descriptor(nativeDescriptor, this)
    }

    // Blood pressure
    async fetchBloodPressureMode(deviceIdentifier: DeviceId, transactionId: ? TransactionId): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        const payload = new Uint8Array([0x02, 0x40, 0xdc, 0x01, 0xb2, 0x2f])
        const value = this.base64ArrayBuffer(payload)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                bloodPressureServiceUUID,
                bloodPressureCharacteristicWriteUUID,
                value,
                true,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    async fetchHistoricBloodPressureMeasurement(
        deviceIdentifier: DeviceId,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        const payload = new Uint8Array([0x02, 0x40, 0xdc, 0x01, 0xb1, 0x2c])
        const value = this.base64ArrayBuffer(payload)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                bloodPressureServiceUUID,
                bloodPressureCharacteristicWriteUUID,
                value,
                true,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    async turnBloodPressureVoiceOff(deviceIdentifier: DeviceId, transactionId: ? TransactionId): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        const payload = new Uint8Array([0x02, 0x40, 0xdc, 0x01, 0xa3, 0x3e])
        const value = this.base64ArrayBuffer(payload)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                bloodPressureServiceUUID,
                bloodPressureCharacteristicWriteUUID,
                value,
                true,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    async startBloodPressureTesting(deviceIdentifier: DeviceId, transactionId: ? TransactionId): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        const payload = new Uint8Array([0x02, 0x40, 0xdc, 0x01, 0xa1, 0x3c])
        const value = this.base64ArrayBuffer(payload)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                bloodPressureServiceUUID,
                bloodPressureCharacteristicWriteUUID,
                value,
                true,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    async setBloodPressureTime(
        deviceIdentifier: DeviceId,
        date: Date,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        const year = parseInt(moment().format('YY'))
        const month = moment(date).month() + 1
        const day = moment(date).date()
        const hour = moment(date).hour()
        const minute = moment(date).minute()
        const second = moment(date).second()

        const payload = [0x02, 0x40, 0xdc, 0x07, 0xb0, year, month, day, hour, minute, second]

        let xorValue = this.XOR(payload)
        payload.push(xorValue)

        const value = this.base64ArrayBuffer(payload)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                bloodPressureServiceUUID,
                bloodPressureCharacteristicWriteUUID,
                value,
                true,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    monitorBloodPressureResponse(
        deviceIdentifier: DeviceId,
        listener: (error: ? BleError, characteristic : ? Characteristic) => void,
        transactionId: ? TransactionId
    ): Subscription {
        const filledTransactionId = transactionId || this._nextUniqueID()
        return this._handleMonitorCharacteristic(
            BleModule.monitorCharacteristicForDevice(
                deviceIdentifier,
                bloodPressureServiceUUID,
                bloodPressureCharacteristicUUID,
                filledTransactionId
            ),
            filledTransactionId,
            listener
        )
    }

    monitorGlucometerResponse(
        deviceIdentifier: DeviceId,
        listener: (error: ? BleError, characteristic : ? Characteristic) => void,
        transactionId: ? TransactionId
    ): Subscription {
        const filledTransactionId = transactionId || this._nextUniqueID()
        return this._handleMonitorCharacteristic(
            BleModule.monitorCharacteristicForDevice(
                deviceIdentifier,
                glucometerServiceUUID,
                glucometerCharacteristicReadUUID,
                filledTransactionId
            ),
            filledTransactionId,
            listener
        )
    }

    monitorOximeterResponse(
      deviceIdentifier: DeviceId,
      listener: (error: ? BleError, characteristic : ? Characteristic) => void,
      transactionId: ? TransactionId
  ): Subscription {
      const filledTransactionId = transactionId || this._nextUniqueID()
      return this._handleMonitorCharacteristic(
          BleModule.monitorCharacteristicForDevice(
              deviceIdentifier,
              oximeterServiceUUID,
              oximeterCharacteristicNotifyUUID,
              filledTransactionId
          ),
          filledTransactionId,
          listener
      )
  }

    async fetchAdditionalGlucometerRecord(
        deviceIdentifier: DeviceId,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        const currentTime = new Date()
        const year = '0X' + parseInt(currentTime.getFullYear().toString().substr(-2)).toString(16)
        const month = '0X' + (currentTime.getMonth() + 1).toString(16)
        const dayNumber = '0X' + currentTime.getDate().toString(16)
        const hour = '0X' + currentTime.getHours().toString(16)
        const minutes = '0X' + currentTime.getMinutes().toString(16)

        const payload = new Uint8Array([
            0x5a,
            0x0a,
            0x03,
            year,
            month,
            dayNumber,
            hour,
            minutes,
            0x00,
            '0X' +
            (
                (parseInt('5a', 16) +
                    parseInt('0a', 16) +
                    parseInt('00', 16) +
                    parseInt(year, 16) +
                    parseInt(month, 16) +
                    parseInt(dayNumber, 16) +
                    parseInt(hour, 16) +
                    parseInt(minutes, 16) +
                    2) %
                256
            ).toString(16)
        ])

        const value = this.base64ArrayBuffer(payload)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                glucometerServiceUUID,
                glucometerCharacteristicWriteUUID,
                value,
                false,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    async setGlucometerTime(
        deviceIdentifier: DeviceId,
        withResponse: boolean,
        transactionId: ? TransactionId
    ): Promise < Characteristic > {
        if (!transactionId) {
            transactionId = this._nextUniqueID()
        }

        const currentTime = new Date()
        const year = '0X' + parseInt(currentTime.getFullYear().toString().substr(-2)).toString(16)
        const month = '0X' + (currentTime.getMonth() + 1).toString(16)
        const dayNumber = '0X' + currentTime.getDate().toString(16)
        const hour = '0X' + currentTime.getHours().toString(16)
        const minutes = '0X' + currentTime.getMinutes().toString(16)

        const payload = new Uint8Array([
            0x5a,
            0x0a,
            0x00,
            year,
            month,
            dayNumber,
            hour,
            minutes,
            0x00,
            '0X' +
            (
                (parseInt('5a', 16) +
                    parseInt('0a', 16) +
                    parseInt('00', 16) +
                    parseInt(year, 16) +
                    parseInt(month, 16) +
                    parseInt(dayNumber, 16) +
                    parseInt(hour, 16) +
                    parseInt(minutes, 16) +
                    2) %
                256
            ).toString(16)
        ])

        const value = this.base64ArrayBuffer(payload)

        const nativeCharacteristic = await this._callPromise(
            BleModule.writeCharacteristicForDevice(
                deviceIdentifier,
                glucometerServiceUUID,
                glucometerCharacteristicWriteUUID,
                value, !!withResponse,
                transactionId
            )
        )
        return new Characteristic(nativeCharacteristic, this)
    }

    XOR(input) {
        if (toString.call(input) !== '[object Array]') return false

        var total = Number(input[0])
        for (var i = 0; i < input.length; i++) {
            if (isNaN(input[i])) {
                continue
            }

            total ^= Number(input[i])
        }

        return total
    }
}