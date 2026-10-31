# Lift Control

### Install fresh PiOS(64bits) on SD card (min 16Gb)

### Download repo zip and decompress to ~/Documents

### install nvm and node 20.15.0

### in repo folder 'run npm i'

### In repo/client 'run npm i && npm run build'

### To add a wifi connection before being on site use 'nmtui' from terminal

### to enable headless go to rpi configuration and choose a headless resolution, then 'sudo systemctl set-default graphical.target' or it won't boot with display anymore

### To start server on reboot add this line to 'crontab -e' :
### '@reboot sleep 10 && cd /home/yac/Documents/lift_control-master/ && /home/yac/.nvm/versions/node/v20.15.0/bin/node server.js'

### Overshoot, saved position, door alerts
- `OVERSHOOT_IGNORE_MS` (default 500): if the floor line is lost less than this before or after a stop at that floor, the lift is still considered at that floor (log: `OVERSHOOT IGNORED`). A line lost after a new move command is handled normally.
- The last confirmed floor is saved to `last_position.json` next to server.js (mock mode: `last_position.mock.json`) and loaded at startup. It is marked stale as soon as the motor starts and only becomes valid again at the next confirmed stop at a floor, so a reboot in the middle of a move (or after a stop between floors) starts with an unknown position. A board reporting LIFT HERE at startup always wins.
- A move refused because a door is open or can't be locked shows `Door open at floor X, lift not moving` on the display for `DOOR_ALERT_MS` (default 10000). Ignored in maintenance mode.
- Mock panel: "Change overshoot" cycles the virtual coast after each stop: inside the ignore window (200 ms), outside it (800 ms), off. `MOCK_OVERSHOOT_M` / `MOCK_OVERSHOOT_DELAY_MS` set the start values.
