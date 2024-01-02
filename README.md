# WORK IN PROGRESS

Raspberry Pi based smoker/bbq pit controller based on a Node.js implementation of Heatermeter's process control and reverse engineering of Meater bluetooth temperature probes.

Not fully functional but needed a place to live other than on a RPi SD card. I make no promises that this repository will remain intact.

Should you find any of the code useful in the meantime, the MIT License applies to this repo in its present state.

## Notes to self...

* Enable i2c
* add `vt.global_cursor_default=0` to `/boot/cmdline.txt` to disable blinking cursor on framebuffer output
* install node (latest) using GitHub direct method
  * https://github.com/nodesource/distributions
  * `NODE_MAJOR=20` for now
* GoodTFT 4" HDMI screen
  * Skip manufacturer install script - enables lots of unnecessary options
  * Display output works on Pi5/Bookworm with no additional config
  * Defaults to portrait mode - use `display_rotate=3` in `config.txt` for landscape (not needed)
  * For SPI touchscreen, enable SPI with `raspi-config` or `dtparam=spi=on` in `config.txt`
  * Then, in /boot/config.txt (or /boot/firmware/config.txt for Bookworm), add:
`dtoverlay=ads7846,cs=1,penirq=25,penirq_pull=2,speed=50000,keep_vref_on=0,swapxy=0,pmax=255,xohms=150,xmin=200,xmax=3900,ymin=200,ymax=3900`
  * After reboot, `ADS7846 Touchscreen` should show up as `/dev/input/eventX` (0 or 1, probably)
  * `sudo apt install evtest` and run `evtest` to test touchscreen from command line (no need for X)

  * Consider `curl -sL https://deb.nodesource.com/setup_20.x | sudo -E bash -` instead of manual nodejs config
  * `npm i <package>`` order matters - fails when using a complete package.json
    * working install order (i2c-bus first, since it seems most problematic):
    * i2c-dev
    * evdev
    * canvas
    * chart.js
    * eventemitter3
    * node-ble

-- Yuri -- (c) 2024