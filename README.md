# Lift Control

### Install fresh PiOS(64bits) on SD card (min 16Gb)

### Download repo zip and decompress do ~/Documents

### install nvm and node 20.15.0

### in repo folder 'run npm i'

### In repo/client 'run npm i && npm run build'

### To add a wifi connection before being on site use 'nmtui' from terminal

### to enable headless go to rpi configuration and choose a headless resolution, then 'sudo systemctl set-default graphical.target' or it won't boot with display anymore

### To start server on reboot add this line to 'crontab -e' :
### '@reboot sleep 10 && cd /home/yac/Documents/lift_control-master/ && /home/yac/.nvm/versions/node/v20.15.0/bin/node server.js'