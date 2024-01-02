/*
 * BBQ Pit PID Controller
 *
 * Facilitates pit PID control using a blower fan (DC motor) and damper
 * (servo). Expects 'MeaterProbe' objects from 'MeaterDaemon.js' to
 * facilitate temperature measurement.
 *
 * Emits an 'output' even of type 'fan' or 'servo' with 'value' equal
 * to the whole number percentage of fan speed or damper opening.
 *
 * Emits an additional 'status' event containing data to display or monitor.
 *
 * This module is a node.js implementation of HeaterMeter's 'grillpid.cpp' and
 * adhers to a similar naming convention with the original comments included
 * where applicable. Many thanks to CapnBry for his outstanding work on
 * HeaterMeter, which I used for several years before deciding to work on my
 * own project, intending to modernize things a bit with Apption Labs' Meater
 * probes and fewer hardware/firmware layers. Hopefully I've done justice to
 * the original project with this implementation!
 *
 * https://github.com/CapnBry/HeaterMeter
 *
 * (c) 2023 -- Yuri -- MIT License
 */

import EventEmitter from "eventemitter3";
import {
    millis,
    constrain,
    mapRange,
    mapPct,
    calcExpMovingAverage,
    calcLowerTrimmedMean,
} from "./utils.js";

const PIDMODE = {
    STARTUP: 0, // attempting to reach temperature for the first time after a setpoint change
    RECOVERY: 1, // attempting to return to temperature after a lid event
    NORMAL: 2, // setpoint has been attained, normal operation
    AUTO_LAST: 2, // anything less than or equal to AUTO_LAST is an automatic mode state
    MANUAL: 3, // manual operation mode
    OFF: 4, // output, alarms, and lid detect disabled
};

const PIDMODE_STR = ["STARTUP", "RECOVERY", "NORMAL", "MANUAL", "OFF"];

const PID_PONMEER_LAMBDA = 0.4;

const LIDOPEN_MIN_AUTORESUME = 30;

// The time (ms) of the measurement period
const TEMP_MEASURE_PERIOD = 1000;
// Number of TEMP_MEASURE_PERIOD per Long PWM mode period
const TEMP_LONG_PWM_CNT = 10;

// Number of times the ouput is adusted over TEMP_MEASURE_PERIOD
// This affects fan boost mode and PIDFLAG_FAN_FEEDVOLT output
// Set to 0 to disable both of these
const TEMP_OUTADJUST_CNT = 3;

// Miniumum number of % of difference in servo position to force immediate move
// set 0 to force continuous servo operation
const SERVO_MIN_THRESH = 5;
// Max number of seconds to hold off a servo write due to being below threshold
const SERVO_MAX_HOLDOFF = 10;

// Arduino calls 'doWork()' at a very high rate
// emulate this by rescheduling fast enough to
// implement longPwm (fan pulse) mode
const DO_WORK_PERIOD = Math.floor(
    TEMP_MEASURE_PERIOD / (TEMP_OUTADJUST_CNT + 1)
);

// 2/(1+Number of samples used in the exponential moving average)
const TEMPPROBE_AVG_SMOOTH = 2.0 / (1.0 + 60.0);
const PID_OUTPUT_AVG_SMOOTH = 2.0 / (1.0 + 240.0);
const TEMP_DEV_THRESHOLD = 0.5;

class PitPID extends EventEmitter {
    constructor() {
        super();
        this._Pid = { P: 2.5, I: 0.0035, D: 6 };
        this._pidCurrent = { P: 0, I: 0, D: 0 };
        this._pidMode = PIDMODE.STARTUP;
        this._pidOutput = 0;
        this._pidOutputAvg = 0;

        this._lastWorkMillis = 0;
        this._periodCounter = 0;

        // Counters used for "long PWM" mode
        this._longPwmTmr = 0;
        this._longPwmRemaining = 0;

        // TODO: implement 'alarms'
        // TODO: implement lid open mode

        this._units = null;
        this._setPoint = null;
        this._currentTemp = null;
        this._temperatureAvg = null;

        this._fanMaxSpeed = 80; // The maximum fan speed percent that will be used in automatic mode
        this._fanMaxStartupSpeed = 100; // boost fan in startup mode
        this._fanActiveFloor = 50; // Active floor means "fan on above this PID output". Must be < 100!
        this._fanMinSpeed = 50; // The minimum fan speed percent before converting to "long PID" (SRTP) mode

        this._servoMinPos = 0;
        this._servoMaxPos = 100;

        this._fanPct = 0;
        this._lastBlowerOutput = 0;

        this._servoActiveCeil = 100;
        this._servoPct = 0;
        this._servoHoldoff = 0;

        this._lidOpenOffset = 5; // percentage of setpoint degrees the temperature drops before automatic lidopen mode
        this._lidOpenDuration = 240; // amount of time (seconds) to turn off the blower when the lid is open
        this._lidOpenTimeout = 0; // implementation of grillpid.cpp LidOpenResumeCountdown

        this._connectedProbes = {}; // probe indices and their relevant data
        this._blacklist = []; // TODO: implement ignored probe indices
        this.doWork();
    }

    get pid() {
        return { ...this._Pid }; // return a copy to avoid direct mutation
    }

    set pid(value) {
        // allows passing one or more terms to update
        if (value.P !== undefined) {
            this._Pid.P = value.P;
        }
        if (value.I !== undefined) {
            this._Pid.I = value.I;
        }
        if (value.D !== undefined) {
            this._Pid.D = value.D;
        }
    }

    get pidMode() {
        return this._pidMode;
    }

    set pidMode(value) {
        this._pidMode = value;
        this._lidOpenTimeout = 0;
        this._pidOutput = 0;
    }

    get fanMaxSpeed() {
        return this._fanMaxSpeed;
    }

    set fanMaxSpeed(value) {
        this._fanMaxSpeed = constrain(value, 0, 100);
    }

    get fanMaxStartupSpeed() {
        return this._fanMaxStartupSpeed;
    }

    set fanMaxStartupSpeed(value) {
        this._fanMaxStartupSpeed = constrain(value, 0, 100);
    }

    get fanCurrentMaxSpeed() {
        return this._pidMode == PIDMODE.STARTUP
            ? this._fanMaxStartupSpeed
            : this._fanMaxSpeed;
    }

    get fanActiveFloor() {
        return this._fanActiveFloor;
    }

    set fanActiveFloor(value) {
        // _fanActiveFloor is constrained to 0-99 to prevent a divide by 0
        this._fanActiveFloor = constrain(value, 0, 99);
    }

    get fanMinSpeed() {
        return this._fanMinSpeed;
    }

    set fanMinSpeed(value) {
        this._fanMinSpeed = constrain(value, 0, 100);
    }

    get servoMinPos() {
        return this._servoMinPos;
    }

    set servoMinPos(value) {
        this._servoMinPos = constrain(value, 0, 100);
    }

    get servoMaxPos() {
        return this._servoMaxPos;
    }

    set servoMaxPos(value) {
        this._servoMaxPos = constrain(value, 0, 100);
    }

    get lidOpenOffset() {
        return this._lidOpenOffset;
    }

    set lidOpenOffset(value) {
        this._lidOpenOffset = constrain(value, 0, 100);
    }

    // Getter and setter for _lidOpenDuration
    get lidOpenDuration() {
        return this._lidOpenDuration;
    }

    set lidOpenDuration(value) {
        this._lidOpenDuration =
            value > LIDOPEN_MIN_AUTORESUME ? value : LIDOPEN_MIN_AUTORESUME;
    }

    get numProbes() {
        return Object.keys(this._connectedProbes).length;
    }

    get pitTemp() {
        return this._currentTemp;
    }

    // return an array containing all probe temperatures
    get allAmbientTemps() {
        return Object.values(this._connectedProbes).map(
            (probe) => probe.ambient
        );
    }

    get setPoint() {
        return this._setPoint;
    }

    set setPoint(value) {
        this.pidMode = PIDMODE.STARTUP;
        this._setPoint = value;
    }

    // manually set pidOutput to invoke manual mode
    // set setPoint to reenable automatic operation
    set pidOutPut(value) {
        this.pidMode = PIDMODE.MANUAL;
        this._pidOutput = constrain(value, 0, 100);
    }

    get pidOutPut() {
        return this._pidOutput;
    }

    get isPitTempReached() {
        return this.pidMode === PIDMODE.NORMAL;
    }

    get isLidOpen() {
        return millis() < this._lidOpenTimeout;
    }

    get lidOpenResumeCountdown() {
        return (millis() - this._lidOpenTimeout) / 1000;
    }

    get hasTemperature() {
        return (
            this.numProbes > 0 &&
            this._currentTemp !== null &&
            !isNaN(this._currentTemp) &&
            this._temperatureAvg !== null &&
            !isNaN(this._temperatureAvg)
        );
    }

    _tempProbeProcessPeriod() {
        // Called once per measurement period
        if (this._currentTemp !== null) {
            this._temperatureAvg = calcExpMovingAverage(
                TEMPPROBE_AVG_SMOOTH,
                this._temperatureAvg,
                this._currentTemp
            );
        }
        // TODO: update alarm status
    }

    _resetLidOpenTimeout() {
        this._pidMode = PIDMODE.RECOVERY;
        this._lidOpenTimeout = millis() + this._lidOpenOffset * 1000;
    }

    _lidModeShouldActivate(tempDiff) {
        // If the pit temperature has been reached
        // and if the pit temperature is [lidOpenOffset]% less that the setpoint
        // and if the fan has been running less than 90% (more than 90% would indicate probable out of fuel)
        // Note that the code assumes we're not currently counting down
        return (
            this._lidOpenOffset > 0 &&
            this.isPitTempReached() &&
            (tempDiff * 100) / this._setPoint >= this._lidOpenOffset &&
            this._pidOutputAvg < 90
        );
    }

    _emitFanOutput(value) {
        this.emit("output", { type: "fan", value: value });
    }

    _emitServoOutput(value) {
        this.emit("output", { type: "servo", value: value });
    }

    _emitStatusReport() {
        this.emit("status", {
            mode: PIDMODE_STR[this.pidMode],
            numProbes: this.numProbes,
            pitTemp: this.pitTemp,
            setPoint: this.setPoint,
            units: this._units,
            pidOutput: this.pidOutPut,
            fanPct: this._fanPct,
            servoPct: mapRange(
                this._servoPct,
                this._servoMinPos,
                this._servoMaxPos,
                0,
                100
            ),
            // TODO: report lid open status
        });
    }

    _commitServoOutput() {
        // Servo is open 0% at 0 PID output and 100% at _servoActiveCeil PID output
        let output = 0;

        if (this._pidOutput >= this._servoActiveCeil) {
            output = 100;
        } else {
            output = (this._pidOutput * 100) / this._servoActiveCeil;
        }

        // Get the output position by LERPing between min and max
        output = mapPct(output, this._servoMinPos, this._servoMaxPos);

        this._servoHoldoff++;

        const isBigMove = Math.abs(output - this._servoPct) > SERVO_MIN_THRESH;

        if (isBigMove || this._servoHoldoff > SERVO_MAX_HOLDOFF) {
            this._servoPct = output;
            this._servoHoldoff = 0;
            this._emitServoOutput(output);
        }
    }

    _commitFanOutput() {
        let newFanSpeed = null;

        if (this._pidOutput < this._fanActiveFloor) {
            newFanSpeed = 0;
        } else {
            const range = 100 - this._fanActiveFloor;
            const max = this.fanCurrentMaxSpeed;
            newFanSpeed =
                ((this._pidOutput - this._fanActiveFloor) * max) / range;
        }

        /* For anything above _minFanSpeed, do a nomal PWM write.
           For below _minFanSpeed we use a "long pulse PWM", where
           the pulse is 10 seconds in length.  For each percent we are
           emulating, run the fan for one interval. */
        this._longPwmRemaining = 0;
        if (newFanSpeed >= this._fanMinSpeed) {
            this._longPwmTmr = 0;
        } else {
            const runningDur = this._longPwmTmr * TEMP_MEASURE_PERIOD;
            const targetDur =
                ((TEMP_LONG_PWM_CNT * TEMP_MEASURE_PERIOD) /
                    this._fanMinSpeed) *
                newFanSpeed;
            if (targetDur > runningDur) {
                newFanSpeed = this._fanMinSpeed;
                this._longPwmRemaining = targetDur - runningDur;
            } else {
                newFanSpeed = 0;
            }
            if (++this._longPwmTmr > TEMP_LONG_PWM_CNT - 1) {
                this._longPwmTmr = 0;
            }
        } /* long PWM */

        // 0 is always 0
        this._fanPct = newFanSpeed;
        if (this._fanPct == 0) {
            this._lastBlowerOutput = 0;
        } else {
            const needBoost = this._lastBlowerOutput == 0;
            this._lastBlowerOutput = this._fanPct;

            // If going from 0% to non-0%, turn the blower fully on for one period
            // to get it moving (boost mode)
            if (needBoost && TEMP_OUTADJUST_CNT > 0) {
                this._emitFanOutput(100);
                return;
            }
        }

        this._emitFanOutput(this._lastBlowerOutput);
    }

    _commitPidOutput() {
        this._pidOutputAvg = calcExpMovingAverage(
            PID_OUTPUT_AVG_SMOOTH,
            this._pidOutputAvg,
            this._pidOutput
        );
        this._commitFanOutput();
        this._commitServoOutput();
        this._emitStatusReport();
    }

    _getPidIMax() {
        return this.isPitTempReached ? 100 : this._fanMaxStartupSpeed;
    }

    _calcPidOutput() {
        const lastOutput = this._pidOutput;
        this._pidOutput = 0;

        if (!this.hasTemperature) {
            return;
        }

        if (this._isLidOpen) {
            return;
        }

        const error = this._setPoint - this._currentTemp;

        if (this._Pid.P < 0) {
            // PPPPP = fan speed percent per degree of temperature minus current
            // lambda * P * error - (1-lambda) * P * curr => P * (lambda * set - curr)
            // (Linear combination of Proportional on Measurement and Error)
            this._pidCurrent.P =
                this._Pid.P *
                (-PID_PONMEER_LAMBDA * this._setPoint + this._currentTemp);
        } else {
            // PPPPP = fan speed percent per degree of error (Proportional on Error)
            this._pidCurrent.P = this._Pid.P * error;
        }

        const high = this._getPidIMax();
        if ((error < 0 && lastOutput > 0) || (error > 0 && lastOutput < high)) {
            this._pidCurrent.I += this._Pid.I * error;
            // If using PoMeEr, the max windup has to be extended to allow 100% output at curr == set
            const exHigh = high;
            if (this._Pid.P < 0.0) {
                exHigh += (-1.0 + PID_PONMEER_LAMBDA) * Pid.P * this._setPoint;
            }
            this._pidCurrent.I = constrain(this._pidCurrent.I, 0, exHigh);
        }

        // DDDDD = fan speed percent per degree of change over TEMPPROBE_AVG_SMOOTH period (Derivative on Measurement)
        this._pidCurrent.D =
            this._Pid.D * (this._temperatureAvg - this._currentTemp);

        // ! the B (bias) term was deprecated in HeaterMeter
        // BBBBB = fan speed percent (always 0)
        // this._pidCurrent.B = this._Pid.B;

        const control =
            this._pidCurrent.P + this._pidCurrent.I + this._pidCurrent.D;
        this._pidOutput = constrain(control, 0, 100);
    }

    _setUnits(units) {
        this._units = units;

        // clear _temperatureAvg to prevent D term jumps on the pit probe
        this._temperatureAvg = null;
        // TODO: implement PID_MODE.OFF, since HeaterMeter uses '0' units as a flag for that, but it seems ungainly here
    }

    // call this when a probe's temperature is updated
    // first call on a newly connected probe will add it to the system
    // triggers weighted averaging and smoothing of temperature
    updateProbe(data) {
        if (!(data.address in this._connectedProbes)) {
            this._connectedProbes[data.address] = {};
        }
        this._connectedProbes[data.address].timestamp = data.timestamp;
        this._connectedProbes[data.address].ambient = data.ambient;

        // call '_setUnits' on unit change
        // assume all probes will emit the same unit
        // assume the user will update the setpoint
        if (data.units !== this._units) {
            this._setUnits(data.units);
        }

        this._currentTemp = calcLowerTrimmedMean(
            this.allAmbientTemps,
            TEMP_DEV_THRESHOLD
        );
    }

    // call this if a probe is no longer available/disconnected
    removeProbe(address) {
        delete this._connectedProbes[address];
    }

    // scheduled at at intervals of at least TEMP_MEASURE_PERIOD / TEMP_OUTADJUST_CNT
    doWork() {
        const elapsed = millis() - this._lastWorkMillis;
        if (this._longPwmRemaining && elapsed > this._longPwmRemaining) {
            this._emitFanOutput(this._fanMaxSpeed);
            this._longPwmRemaining = 0;
            this._lastBlowerOutput = 0;
        }

        if (TEMP_OUTADJUST_CNT > 0) {
            if (
                elapsed >
                this._periodCounter * (TEMP_MEASURE_PERIOD / TEMP_OUTADJUST_CNT)
            ) {
                ++this._periodCounter;
            }
        }

        if (elapsed < TEMP_MEASURE_PERIOD) {
            setTimeout(() => this.doWork(), DO_WORK_PERIOD);
            return;
        }

        this._periodCounter = 1;
        this._lastWorkMillis = millis();
        this._tempProbeProcessPeriod();

        if (this._pidMode <= PIDMODE.AUTO_LAST) {
            // Always calculate the output
            // calcPidOutput() will bail if it isn't supposed to be in control
            this._calcPidOutput();
        }

        const tempDiff = this._setPoint - this._currentTemp;

        if (
            tempDiff <= 0 &&
            this._lidOpenDuration - this.lidOpenResumeCountdown >=
                LIDOPEN_MIN_AUTORESUME
        ) {
            // When we first achieve temperature, reduce any I sum we accumulated during startup
            // If we actually neded that sum to achieve temperature we'll rebuild it, and it
            // prevents bouncing around above the temperature when you first start up
            if (this._pidMode == PIDMODE.STARTUP) {
                this._pidCurrent.I *= 0.5;
            }
            this._pidMode = PIDMODE.NORMAL;
            this._lidOpenTimeout = 0;
        } else if (this.lidOpenResumeCountdown != 0) {
            this._lidOpenTimeout =
                this.lidOpenResumeCountdown * 1000 - TEMP_MEASURE_PERIOD;
        } else if (this._lidModeShouldActivate(tempDiff)) {
            this._resetLidOpenTimeout();
        }

        this._commitPidOutput();
        setTimeout(() => this.doWork(), DO_WORK_PERIOD);
    }
}

export { PitPID as default, PitPID };
