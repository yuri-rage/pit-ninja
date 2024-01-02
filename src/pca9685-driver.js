/*
 * PCA9685 Driver
 *
 * Provides a driver for the PCA9685 PWM controller to control servo motors and
 * brushed DC motors with precise timing.
 *
 * The module exposes a PCA9685 class with functions to initialize the device,
 * set PWM frequency, control DC motors, and adjust servo motor positions. It is
 * designed for use with the 'i2c-bus' and 'eventemitter3' npm packages and
 * assumes use of the SeenGreat Motor and Servo Driver Hat for Raspberry Pi.
 *
 * https://seengreat.com/product/211/motor-and-servo-driver-hat
 *
 * Ported from the SeenGreat Python example at https://seengreat.com/wiki/91/
 *
 * (c) 2023 -- Yuri -- MIT License
 */

import { openSync } from "i2c-bus";
import EventEmitter from "eventemitter3";

// PCA9685 mode control bits
const INIT_MODE = 0x00;
const SLEEP_MODE_BIT = 0x10;
const WAKE_MODE_BIT = 0x80;

// PCA9685 Registers
// (commented values for sake of completeness - unnecessary for motor control)
// const SUBADR1 = 0x02;
// const SUBADR2 = 0x03;
// const SUBADR3 = 0x04;
const MODE1 = 0x00;
// const MODE2 = 0x01;
const PRESCALE = 0xfe;
const LED0_ON_L = 0x06;
const LED0_ON_H = 0x07;
const LED0_OFF_L = 0x08;
const LED0_OFF_H = 0x09;
// const ALLLED_ON_L = 0xFA;
// const ALLLED_ON_H = 0xFB;
// const ALLLED_OFF_L = 0xFC;
// const ALLLED_OFF_H = 0xFD;

// PWM Channels for Servo and DC Motors
const SERVO_MOTOR_PWM3 = 6;
const SERVO_MOTOR_PWM4 = 7;
const SERVO_MOTOR_PWM5 = 8;
const SERVO_MOTOR_PWM6 = 9;
const SERVO_MOTOR_PWM7 = 10;
const SERVO_MOTOR_PWM8 = 11;

const DC_MOTOR_PWM1 = 0;
const DC_MOTOR_INA1 = 2;
const DC_MOTOR_INA2 = 1;

const DC_MOTOR_PWM2 = 5;
const DC_MOTOR_INB1 = 3;
const DC_MOTOR_INB2 = 4;

// PCA9865 pwm constants
const DUTY_CYCLE_MIN = 0;
const DUTY_CYCLE_MAX = 4095;

class PCA9685 extends EventEmitter {
    constructor(i2cAddress = 0x7f, i2cBus = 1, pwmFreq = 50) {
        super();
        this.bus = openSync(i2cBus);
        this.devAddr = i2cAddress;
        this.writeReg(MODE1, INIT_MODE);
        this.initialized = false;
        this.sendPWMCommandFreq(pwmFreq);
    }

    writeReg(reg, value) {
        this.bus.writeByteSync(this.devAddr, reg, value);
    }

    readReg(reg) {
        return this.bus.readByteSync(this.devAddr, reg);
    }

    sendPWMCommandFreq(freq) {
        let prescaleVal = 25000000.0;
        prescaleVal /= 4096.0;
        prescaleVal /= freq;
        prescaleVal -= 1.0;
        const prescale = Math.floor(prescaleVal + 0.5);

        const oldMode = this.readReg(MODE1);
        this.writeReg(MODE1, (oldMode & 0x7f) | SLEEP_MODE_BIT); // sleep
        this.writeReg(PRESCALE, Math.floor(prescale));
        // sleep for a short time to allow the oscillator to stabilize
        setTimeout(() => {
            this.writeReg(MODE1, oldMode | WAKE_MODE_BIT);
            this.initialized = true;
            this.emit("initialized");
        }, 5);
    }

    sendPWMCommand(channel, on, off) {
        if (!this.initialized) {
            throw new Error(
                "PCA9685 not initialized. Call sendPWMCommandFreq() first."
            );
        }
        this.writeReg(LED0_ON_L + 4 * channel, on & 0xff);
        this.writeReg(LED0_ON_H + 4 * channel, on >> 8);
        this.writeReg(LED0_OFF_L + 4 * channel, off & 0xff);
        this.writeReg(LED0_OFF_H + 4 * channel, off >> 8);
    }

    setDutyCycle(channel, dutyCycle) {
        this.sendPWMCommand(
            channel,
            0,
            Math.min(DUTY_CYCLE_MAX, Math.max(DUTY_CYCLE_MIN, dutyCycle))
        );
    }

    setMotorSpeed(motorIndex, speed, reverse = false) {
        let in1 = reverse ? DUTY_CYCLE_MAX : DUTY_CYCLE_MIN;
        let in2 = reverse ? DUTY_CYCLE_MIN : DUTY_CYCLE_MAX;
        speed = Math.min(DUTY_CYCLE_MAX, Math.max(DUTY_CYCLE_MIN, speed));

        switch (motorIndex) {
            case 1:
                this.setDutyCycle(DC_MOTOR_PWM1, speed);
                this.setDutyCycle(DC_MOTOR_INA1, in1);
                this.setDutyCycle(DC_MOTOR_INA2, in2);
                break;
            case 2:
                this.setDutyCycle(DC_MOTOR_PWM2, speed);
                this.setDutyCycle(DC_MOTOR_INB1, in1);
                this.setDutyCycle(DC_MOTOR_INB2, in2);
                break;
            default:
                throw new Error(
                    `${motorIndex}: invalid DC motor index. Must be 1 or 2.`
                );
        }
    }

    setServoPosition(servoIndex, pulseWidth) {
        let dutyCycle = Math.floor((pulseWidth * 4096) / 20000); // convert µs to 12 bit duty cycle
        let channel;
        switch (servoIndex) {
            case 3:
                channel = SERVO_MOTOR_PWM3;
                break;
            case 4:
                channel = SERVO_MOTOR_PWM4;
                break;
            case 5:
                channel = SERVO_MOTOR_PWM5;
                break;
            case 6:
                channel = SERVO_MOTOR_PWM6;
                break;
            case 7:
                channel = SERVO_MOTOR_PWM7;
                break;
            case 8:
                channel = SERVO_MOTOR_PWM8;
                break;
            default:
                throw new Error(
                    `${servoIndex}: invalid servo index. Must be 3 through 8.`
                );
        }
        this.setDutyCycle(channel, dutyCycle);
    }
}

export { PCA9685 as default, PCA9685 };

/********** EXAMPLE USAGE **********/
/*
if (require.main === module) {
    const pwm = new PCA9685();

    // DC Motor Control
    async function controlDCMotor() {
        if (pwm.initialized) {
            pwm.setMotorSpeed(1, DUTY_CYCLE_MAX, true);
            console.log("M1 rotate opposite");
            await sleep(3000);
            pwm.setMotorSpeed(1, DUTY_CYCLE_MIN, true);
            console.log("M1 stop");
            await sleep(2000);
        }
    }

    // Servo Motor Control
    async function controlServoMotor() {
        console.log("servo cw");
        for (let i = 2500; i >= 500; i -= 10) {
            if (pwm.initialized) {
                pwm.setServoPosition(3, i);
            }
            await sleep(20);
        }
        console.log("servo ccw");
        for (let i = 500; i <= 2500; i += 10) {
            if (pwm.initialized) {
                pwm.setServoPosition(3, i);
            }
            await sleep(20);
        }
    }

    // promise-based sleep
    function sleep(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    // run asynchronously
    (async () => {
        await sleep(100);
        while (true) {
            await controlDCMotor();
            await controlServoMotor();
        }
    })();
}
*/
