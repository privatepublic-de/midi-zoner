# midi-zoner

Application to play multiple MIDI devices, MIDI channels and note ranges from one MIDI input source. Includes an arpeggiator with euclidian patterns and customizable CC controllers.

My main motive to start programming "midi-zoner": I wanted to interact and perform with my MIDI gear without the hassle of starting a big and bloated DAW to distribute my master keyboard to multiple destinations. And neither did I like to fiddle around with tiny 16-character LCD screens to configure mentioned master keyboard for multiple zones and channels.

This is an [Electron](https://www.electronjs.org/) application. Build it with node.js/npm.

- Make sure you have a current version of node.js/npm installed
- Clone this repository
- In the repository's directory call `npm install`
- Enter `npm start` to test the application
- You can build the application with `npm run build:win` (exe file), `npm run build:linux` (AppImage) or `npm run build:mac` (dmg) for the respective platform. The application will be built to the "dist" directory. For Mac OS you can use `npm run pack:osx` to build a simple "app" without packing it into a dmg file.

## User manual

You can find the complete user manual on the wiki pages of this repository: [midi-zoner User Manual](https://github.com/privatepublic-de/midi-zoner/wiki)

## Download releases

Download pre-built release versions here under [releases](https://github.com/privatepublic-de/midi-zoner/releases). There are builds for Mac OS, Windows and Linux (AppImage) – all 64-Bit.
