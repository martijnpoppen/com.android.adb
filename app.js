'use strict';

const Homey = require('homey');

class AdbTabletApp extends Homey.App {

  async onInit() {
    this.log('Android Control app started');
  }

}

module.exports = AdbTabletApp;
