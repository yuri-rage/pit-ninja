/*
 * BBQ Pit Airflow Control Module
 *
 * Facilitates pit airflow control using a blower fan (DC motor) and damper
 * (servo). It is designed for use with the 'eventemitter3' npm package and
 * locally installed 'pca9685-driver' module and assumes use of the SeenGreat
 * Motor and Servo Driver Hat for Raspberry Pi.
 *
 * https://seengreat.com/product/211/motor-and-servo-driver-hat
 *
 * (c) 2023 -- Yuri -- MIT License
 */

import EventEmitter from "eventemitter3";
import PCA9685 from "./pca9685-driver.js";
import { constrain, constrainBoolean, mapRange } from "./utils.js";

const MOTOR_INDEX_MIN = 1;
const MOTOR_INDEX_MAX = 2;
const SERVO_INDEX_MIN = 3;
const SERVO_INDEX_MAX = 8;
const DUTY_CYCLE_MIN = 0;
const DUTY_CYCLE_MAX = 4095;
const SERVO_MIN = 500;
const SERVO_MAX = 2500;
const MOTOR_OFF = 0;
const MOTOR_MIN = 0;
const MOTOR_MAX = 100;

const DRIVER_NUM_RETRIES = 5; // number of retries for failed speed/position commands
const DRIVER_TIMEOUT = 100; // time between retries

class PitAirflow extends EventEmitter {
    constructor(
        fanMotorIndex = 1,
        fanMotorReversed = false,
        damperServoIndex = 3,
        damperServoReversed = false,
        driverAddress = 0x07f,
        driverBusIndex = 1
    ) {
        super();
        this._fanMotor = constrain(
            fanMotorIndex,
            MOTOR_INDEX_MIN,
            MOTOR_INDEX_MAX
        );
        this._fanMin = 0;
        this._fanMax = 100;
        this._fanReverse = constrainBoolean(fanMotorReversed);
        this._fanRetries = 0;
        this._fanSpeed = null;
        this._damperServo = constrain(
            damperServoIndex,
            SERVO_INDEX_MIN,
            SERVO_INDEX_MAX
        );
        this._damperMin = 0;
        this._damperMax = 100;
        this._damperReverse = constrainBoolean(damperServoReversed);
        this._damperRetries = 0;
        this._damperPosition = null;
        this._driverBusIndex = driverBusIndex;
        this._driverAddress = driverAddress;
        this._initialized = false;
        this._driver = null;
        this._initializePCA9685Driver();
    }

    _initializePCA9685Driver() {
        this._initialized = false;
        this._driver = new PCA9685(this._driverAddress, this._driverBusIndex);
        this._driver.on("initialized", () => {
            this._initialized = true;
            this.emit("initialized");
        });
    }

    get initialized() {
        return this._initialized;
    }

    get fanMotor() {
        return this._fanMotor;
    }

    set fanMotor(value) {
        this._fanMotor = this.constrain(
            value,
            MOTOR_INDEX_MIN,
            MOTOR_INDEX_MAX
        );
    }

    get fanReversed() {
        return this._fanReverse;
    }

    set fanReversed(value) {
        this._fanReverse = constrainBoolean(value);
    }

    get damperServo() {
        return this._damperServo;
    }

    set damperServo(value) {
        this._damperServo = this.constrain(
            value,
            SERVO_INDEX_MIN,
            SERVO_INDEX_MAX
        );
    }

    get damperReversed() {
        return this._damperReverse;
    }

    set damperReversed(value) {
        this._damperReverse = constrainBoolean(value);
    }

    get fanMin() {
        return this._fanMin;
    }

    set fanMin(value) {
        this._fanMin = constrain(value, MOTOR_MIN, MOTOR_MAX);
    }

    get fanMax() {
        return this._fanMax;
    }

    set fanMax(value) {
        this._fanMax = constrain(value, MOTOR_MIN, MOTOR_MAX);
    }

    get damperMin() {
        return this._damperMin;
    }

    set damperMin(value) {
        this._damperMin = value;
    }

    get damperMax() {
        return this._damperMax;
    }

    set damperMax(value) {
        this._damperMax = value;
    }

    get driverBus() {
        return this._driverBusIndex;
    }

    set driverBus(value) {
        this._driverBusIndex = value;
        this._initializePCA9685Driver();
    }

    get driverAddress() {
        return this._driverAddress;
    }

    set driverAddress(value) {
        this._driverAddress = value;
        this._initializePCA9685Driver();
    }

    getDamperPosition() {
        return this._damperPosition;
    }

    setDamperPosition(value) {
        if (!this._initialized) {
            if (this._damperRetries > DRIVER_NUM_RETRIES) {
                throw new Error("PCA9685 driver initialization timeout.");
            }
            this._damperRetries++;
            setTimeout(() => {
                this.setDamperPosition(value);
            }, DRIVER_TIMEOUT);
            return;
        }
        this._damperRetries = 0;
        const correctedValue = this._damperReverse ? MOTOR_MAX - value : value;
        const scaledValue = mapRange(
            correctedValue,
            MOTOR_MIN,
            MOTOR_MAX,
            this._damperMin,
            this._damperMax
        );
        const scaledOutput = mapRange(
            scaledValue,
            MOTOR_MIN,
            MOTOR_MAX,
            SERVO_MIN,
            SERVO_MAX
        );
        this._driver.setServoPosition(this._damperServo, scaledOutput);
        this._damperPosition = constrain(value, MOTOR_MIN, MOTOR_MAX);
    }

    getFanSpeed() {
        return this._fanSpeed;
    }

    setFanSpeed(value) {
        if (!this._initialized) {
            if (this._fanRetries > DRIVER_NUM_RETRIES) {
                throw new Error("PCA9685 driver initialization timeout.");
            }
            this._fanRetries++;
            setTimeout(() => {
                this.setFanSpeed(value);
            }, DRIVER_TIMEOUT);
            return;
        }
        this._fanRetries = 0;
        if (value == MOTOR_OFF) {
            // do not scale "off"
            this._driver.setMotorSpeed(
                this._fanMotor,
                MOTOR_OFF,
                this._fanReverse
            );
            this._fanSpeed = MOTOR_OFF;
            return;
        }
        const scaledValue = mapRange(
            value,
            MOTOR_MIN,
            MOTOR_MAX,
            this._fanMin,
            this._fanMax
        );
        const scaledOutput = mapRange(
            scaledValue,
            MOTOR_MIN,
            MOTOR_MAX,
            DUTY_CYCLE_MIN,
            DUTY_CYCLE_MAX
        );
        this._driver.setMotorSpeed(
            this._fanMotor,
            scaledOutput,
            this._fanReverse
        );
        this._fanSpeed = constrain(value, MOTOR_MIN, MOTOR_MAX);
    }
}

export { PitAirflow as default, PitAirflow };
