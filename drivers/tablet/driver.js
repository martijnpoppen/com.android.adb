'use strict';

const crypto = require('node:crypto');
const Homey = require('homey');
const AdbClient = require('../../lib/AdbClient');
const CredentialStore = require('../../lib/CredentialStore');
const { pair } = require('../../lib/AdbPairing');
const { localizeError } = require('../../lib/errors');

class TabletDriver extends Homey.Driver {

  async onInit() {
    this.credentialStore = new CredentialStore(this.homey);

    // Connection errors reach the Flow in the user's language.
    const translated = (run) => async (args, state) => {
      try {
        return await run(args, state);
      } catch (err) {
        throw args.device.localizeError(err);
      }
    };
    const action = (id, run) => {
      const card = this.homey.flow.getActionCard(id);
      card.registerRunListener(translated(run));
      return card;
    };
    const condition = (id, run) => {
      const card = this.homey.flow.getConditionCard(id);
      card.registerRunListener(translated(run));
      return card;
    };
    const appSearch = async (query, args) => args.device.listApps(query);

    action('run_shell_command', async ({ device, command }) => { await device.runShell(command); });
    action('open_url', async ({ device, url }) => device.openUrl(url));
    action('press_key', async ({ device, key }) => device.pressKey(key));
    action('type_text', async ({ device, text }) => device.typeText(text));
    action('set_stay_awake', async ({ device, enabled }) => device.setStayAwake(enabled === 'true'));
    action('set_screen_timeout', async ({ device, seconds }) => device.setScreenTimeout(seconds));
    action('launch_app', async ({ device, app }) => device.launchApp(app.id))
      .registerArgumentAutocompleteListener('app', appSearch);

    action('take_screenshot', async ({ device }) => { await device.takeScreenshot(); });
    action('take_photo', async ({ device, camera }) => { await device.takePhoto(camera); });
    action('show_url', async ({ device, url }) => device.showOnScreen({ url }));
    action('show_app', async ({ device, app }) => device.showOnScreen({ app: app.id }))
      .registerArgumentAutocompleteListener('app', appSearch);
    action('close_app', async ({ device, app }) => device.closeApp(app.id))
      .registerArgumentAutocompleteListener('app', appSearch);
    action('tap_screen', async ({ device, x, y }) => device.touch(x, y));
    action('swipe_screen', async ({ device, x1, y1, x2, y2 }) => device.touch(x1, y1, x2, y2));
    action('set_stream_volume', async ({ device, stream, volume }) => device.setStreamVolume(stream, volume));
    action('set_bluetooth', async ({ device, state }) => device.setBluetooth(state === 'true'));
    action('restart_device', async ({ device }) => device.reboot());
    action('set_do_not_disturb', async ({ device, mode }) => device.setDoNotDisturb(mode));
    action('set_auto_rotate', async ({ device, state }) => device.setAutoRotate(state === 'true'));
    action('show_notification', async ({ device, title, text }) => device.showNotification(title, text));

    condition('is_charging', async ({ device }) => device.pluggedIn === true);
    condition('bluetooth_on', async ({ device }) => (await device.readBluetooth()) === true);
    condition('app_in_foreground', async ({ device, app }) => (await device.getForegroundApp()) === app.id)
      .registerArgumentAutocompleteListener('app', appSearch);
  }

  /** Devices that currently announce Wireless debugging on the network. */
  getAnnouncedDevices() {
    try {
      const added = this.getDevices().map((device) => device.getSetting('host'));
      const results = this.getDiscoveryStrategy().getDiscoveryResults();
      return Object.values(results).map(({ name, address, port }) => ({
        name, address, port, added: added.includes(address),
      }));
    } catch (err) {
      this.error('Discovery not available:', err.message);
      return [];
    }
  }

  /**
   * Pairs with a pairing code when one is given (Wireless debugging), then
   * connects to check that the device accepts us.
   * @returns {Promise<{ host, port, model, serial }>}
   */
  async connectDevice({ host, port, pairingPort, pairingCode }) {
    host = String(host || '').trim();
    port = Number(port) || 5555;
    pairingCode = String(pairingCode || '').replace(/\s/g, '');
    if (!host) throw new Error(this.homey.__('errors.enter_host'));

    if (pairingCode) {
      pairingPort = Number(pairingPort);
      if (!pairingPort) throw new Error(this.homey.__('errors.enter_pairing_port'));

      this.log(`Pairing with ${host}:${pairingPort} using a pairing code...`);
      const key = await this.credentialStore.getOrCreateKey();
      try {
        await pair({
          host,
          port: pairingPort,
          code: pairingCode,
          privateKey: key.buffer,
          publicKey: await AdbClient.getAdbPublicKey(key),
        });
      } catch (err) {
        this.error('Pairing failed:', err.message);
        throw localizeError(this.homey, err, `${host}:${pairingPort}`);
      }
      this.log('Pairing code accepted');
    }

    this.log(`Connecting to ${host}:${port}...`);
    const client = new AdbClient({ host, port, credentialStore: this.credentialStore });
    try {
      await client.connect({ authTimeout: 60000 });
      this.log(`Connected and authorized (${client.secure ? 'Wireless debugging / TLS' : 'classic ADB'})`);
      const model = await client.shell('getprop ro.product.model').catch(() => '');
      const serial = await client.shell('getprop ro.serialno').catch(() => '');
      return { host, port, model, serial };
    } catch (err) {
      this.error('Connecting failed:', err.message);
      throw localizeError(this.homey, err, `${host}:${port}`);
    } finally {
      await client.disconnect();
    }
  }

  async onPair(session) {
    session.setHandler('discover', async () => this.getAnnouncedDevices());

    session.setHandler('connect', async (input) => {
      const { host, port, model, serial } = await this.connectDevice(input);
      const validSerial = /^[\w.:-]{4,64}$/.test(serial) && serial !== 'unknown';
      return {
        device: {
          name: model || this.homey.__('device.default_name'),
          data: { id: validSerial ? serial : crypto.randomUUID() },
          settings: { host, port },
        },
      };
    });
  }

  async onRepair(session, device) {
    session.setHandler('discover', async () => this.getAnnouncedDevices());

    session.setHandler('connect', async (input) => {
      const { host, port } = await this.connectDevice(input);
      await device.useAddress(host, port);
      return { repaired: true };
    });
  }

}

module.exports = TabletDriver;
