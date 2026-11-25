'use strict';

// Android gives no cheap way to read an app's display name over ADB (it lives in
// the APK's resources). So: a list of well-known apps, and for the rest a readable
// guess from the package name ("com.oneplus.camera" -> "Oneplus Camera").
const KNOWN = {
  'com.spotify.music': 'Spotify',
  'com.google.android.youtube': 'YouTube',
  'com.google.android.apps.youtube.music': 'YouTube Music',
  'com.google.android.apps.youtube.kids': 'YouTube Kids',
  'com.netflix.mediaclient': 'Netflix',
  'com.disney.disneyplus': 'Disney+',
  'com.amazon.avod.thirdpartyclient': 'Prime Video',
  'com.amazon.mp3': 'Amazon Music',
  'com.plexapp.android': 'Plex',
  'org.videolan.vlc': 'VLC',
  'tv.twitch.android.app': 'Twitch',
  'com.apple.android.music': 'Apple Music',
  'deezer.android.app': 'Deezer',
  'com.soundcloud.android': 'SoundCloud',
  'tunein.player': 'TuneIn',
  'com.sonos.acr2': 'Sonos',
  'com.android.chrome': 'Chrome',
  'org.mozilla.firefox': 'Firefox',
  'com.microsoft.emmx': 'Edge',
  'com.brave.browser': 'Brave',
  'com.opera.browser': 'Opera',
  'com.sec.android.app.sbrowser': 'Samsung Internet',
  'de.ozerov.fully': 'Fully Kiosk Browser',
  'app.homey': 'Homey',
  'io.homeassistant.companion.android': 'Home Assistant',
  'com.google.android.apps.chromecast.app': 'Google Home',
  'com.amazon.dee.app': 'Alexa',
  'com.philips.lighting.hue2': 'Philips Hue',
  'com.ikea.inter.homesmart.system2': 'IKEA Home smart',
  'com.tuya.smartlife': 'Smart Life',
  'com.whatsapp': 'WhatsApp',
  'org.telegram.messenger': 'Telegram',
  'org.thoughtcrime.securesms': 'Signal',
  'com.facebook.katana': 'Facebook',
  'com.facebook.orca': 'Messenger',
  'com.instagram.android': 'Instagram',
  'com.zhiliaoapp.musically': 'TikTok',
  'com.snapchat.android': 'Snapchat',
  'com.twitter.android': 'X',
  'com.discord': 'Discord',
  'com.slack': 'Slack',
  'com.microsoft.teams': 'Teams',
  'us.zoom.videomeetings': 'Zoom',
  'com.google.android.gm': 'Gmail',
  'com.microsoft.office.outlook': 'Outlook',
  'com.google.android.apps.maps': 'Google Maps',
  'com.waze': 'Waze',
  'com.google.android.apps.photos': 'Google Photos',
  'com.google.android.calendar': 'Google Calendar',
  'com.google.android.keep': 'Google Keep',
  'com.google.android.apps.docs': 'Google Drive',
  'com.google.android.googlequicksearchbox': 'Google',
  'com.google.android.apps.messaging': 'Messages',
  'com.google.android.dialer': 'Phone',
  'com.google.android.contacts': 'Contacts',
  'com.google.android.deskclock': 'Clock',
  'com.google.android.calculator': 'Calculator',
  'com.google.android.GoogleCamera': 'Camera',
  'com.android.vending': 'Play Store',
  'com.android.settings': 'Settings',
  'com.android.systemui': 'System UI',
  'com.android.launcher3': 'Home screen',
  'com.google.android.apps.nexuslauncher': 'Home screen',
  'net.oneplus.launcher': 'Home screen',
  'com.android.launcher': 'Home screen',
  'com.sec.android.app.launcher': 'Home screen',
  'com.miui.home': 'Home screen',
  'com.amazon.firelauncher': 'Home screen',
  'com.android.camera': 'Camera',
  'com.android.dialer': 'Phone',
  'com.android.contacts': 'Contacts',
  'com.android.deskclock': 'Clock',
  'com.android.calculator2': 'Calculator',
  'com.android.documentsui': 'Files',
};

// Parts of a package name that say nothing about the app.
const NOISE = new Set(['com', 'org', 'net', 'io', 'app', 'apps', 'android', 'mobile', 'client', 'www',
  'de', 'nl', 'uk', 'co', 'eu', 'us', 'fr', 'it', 'se', 'no', 'dk', 'es', 'pl', 'ru', 'kr', 'tv', 'me', 'dev', 'thirdpartyclient', 'mediaclient']);

/**
 * @param {string} packageName e.g. "com.spotify.music"
 * @returns {string} e.g. "Spotify"
 */
function appName(packageName) {
  if (!packageName) return '';
  if (KNOWN[packageName]) return KNOWN[packageName];
  const parts = packageName.split('.').filter((part) => part && !NOISE.has(part.toLowerCase()));
  if (!parts.length) return packageName;
  // "google.youtube" style leftovers: keep at most the last two meaningful parts.
  return parts.slice(-2)
    .map((part) => part.replace(/[_-]+/g, ' ').replace(/\d+$/, '').trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || packageName;
}

module.exports = { appName, KNOWN };
