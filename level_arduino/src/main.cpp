// grok help on deploying to all arduinos from lift server terminal in ssh
// details : https://grok.com/share/bGVnYWN5LWNvcHk%3D_a1c7d729-4ea4-4b84-9d09-aeec722b42f6
// copy to server : scp -r /Users/tina/Downloads/lift_control-master\ 0925/level_arduino yac@lift.local:/home/yac/Documents/lift_control-master/
// ssh : ssh yac@lift.local
// go to folder : cd Documents/lift_control-master/level_arduino/
// upload code to modules : pio run --target upload -e nanoatmega328_0 -e nanoatmega328_1 -e nanoatmega328_2 -e nanoatmega328_3

#include <Arduino.h>
#include "DigitalInput.h"

//id&jumpers
const char module_names[][20] = {"B", "G", "1", "2"};
char module_id[20];
const int pins[] = {6, 7, 8, 9};

//speaker
const int speakerPin = 13;

//inputs
DigitalInput lift_sensor(2,false,true); // digital IR sensor
DigitalInput door_sensor(3,true,true); // digital IR sensor
DigitalInput call_button(4,true,true); // push button

//outputs
const int PIN_LOCKDOOR = 12; // SSR -> 12v magnetic lock  

//state variables
bool door_closed = false;
bool door_locked = false;
bool door_lock_requested = false;
bool lift_present = false;
bool call_button_pressed = false;
bool calibrartion_status = false;

unsigned long lastHeartbeat = 0;
const unsigned long HEARTBEAT_INTERVAL = 500; // Heartbeat every 0.5 s so the server can detect a silent board within ~2 s (BOARD_SILENT_MS=2000)

////////////////////////////////////////////////////////////////////
// CUSTOM FUNCTIONS

String read_string_from_server() {
  String _str = Serial.readStringUntil('\n');
  int lastIndex = _str.length() - 1;
  _str.remove(lastIndex);
  return _str;
} 

void write_string_to_server(String mess) {
  Serial.print(module_id);
  Serial.println(" : "+mess);
}

void sendHeartbeat() {
  write_string_to_server("<3");
}

void lock_if_requested_and_closed() {
  if (door_lock_requested && door_closed){
    digitalWrite(PIN_LOCKDOOR, HIGH);
    door_locked = true;
    write_string_to_server("DOOR LOCKED");
    door_lock_requested=false;
  } else {
    write_string_to_server("CAN'T LOCK DOOR");
    write_string_to_server("door_lock_requested = "+String(door_lock_requested?"true":"false"));
    write_string_to_server("door_closed = "+String(door_closed?"true":"false"));
  }
}

void lock_door_request() {
  door_lock_requested = true;
  write_string_to_server("DOOR LOCK REQUESTED");
  lock_if_requested_and_closed();
}

void unlock_door() {
  door_lock_requested = false;
  digitalWrite(PIN_LOCKDOOR, LOW);
  door_locked = false;
  write_string_to_server("DOOR UNLOCKED");
}

void setModuleId() {
  int moduleSelect = 0;
  for (int i = 0; i <= 3; i++) {
    if (!digitalRead(pins[i])) {
      moduleSelect = i;
      // Serial.println(i);
    }
  }
  strcpy(module_id, module_names[moduleSelect]);
}

void beepModuleID() {
  int beepCount = 0;
  int delayTime = 0; // Delay between beeps in milliseconds
  if (strcmp(module_id, "B") == 0) {
    beepCount = 1;
    delayTime = 0; // No delay needed for single beep
  } else if (strcmp(module_id, "G") == 0) {
    beepCount = 2;
    delayTime = 1000; // 1-second delay
  } else if (strcmp(module_id, "1") == 0) {
    beepCount = 3;
    delayTime = 2000; // 2-second delay
  } else if (strcmp(module_id, "2") == 0) {
    beepCount = 4;
    delayTime = 3000; // 3-second delay
  }
  delay(delayTime);
  for (int i = 0; i < beepCount; i++) {
    tone(speakerPin, 1000, 100); // 1kHz tone for 100ms
    delay(150); // 100ms tone + 50ms break
  }
}
////////////////////////////////////////////////////////////////////
// SETUP & LOOP
void setup() {
  Serial.begin(9600);

  for (int i = 0; i < 4; i++) {
    pinMode(pins[i], INPUT_PULLUP);
    delay(50);
  }
  setModuleId();
  // Serial.println(module_id);
  beepModuleID();
  
  pinMode(PIN_LOCKDOOR, OUTPUT);
  door_sensor.init();
  lift_sensor.init();
  call_button.init();
  // initial sensor read
  door_closed = door_sensor.readNow();
  lift_present = lift_sensor.readNow();
  call_button_pressed = call_button.readNow();
  // send to server
  write_string_to_server(String("initial door_sensor (")+String(door_sensor.getPin())+") : "+(door_closed?"DOOR CLOSED":"DOOR OPEN"));
  write_string_to_server(String("initial lift_sensor (")+String(lift_sensor.getPin())+") : "+(lift_present?"LIFT HERE":"LIFT AWAY"));
  write_string_to_server(String("initial call_button (")+String(call_button.getPin())+") : "+(call_button_pressed?"CALL BUTTON PRESSED":"CALL BUTTON IDLE"));

  if(!lift_present && door_closed) lock_door_request();

  lastHeartbeat = millis(); // Initialize heartbeat timer
}

void loop() {
  delay(1);

  // Send heartbeat periodically
  if (millis() - lastHeartbeat > HEARTBEAT_INTERVAL) {
    sendHeartbeat();
    lastHeartbeat = millis();
  }

  if (Serial.available() > 0) {

    tone(speakerPin, 2000, 50);
    String cmd_str = read_string_from_server();
    // write_string_to_server("..... "+cmd_str);
    if (cmd_str=="UNLOCK_DOOR"){
      delay(200);
      tone(speakerPin, 4000, 50);
      unlock_door();
    }
    else if (cmd_str=="LOCK_DOOR"){
      tone(speakerPin, 2000, 50);
      lock_door_request();
    }
    else if (cmd_str=="SUCCESSFULL_CALIBRATION") calibrartion_status = true;
    else if (cmd_str=="LOST_CALIBRATION") calibrartion_status = false;
  }

  byte ds = door_sensor.readDebounced();
  if (ds!=0){
    door_closed = ds-1;
    write_string_to_server(door_closed?"DOOR CLOSED":"DOOR OPEN");
    lock_if_requested_and_closed();
    if (!door_closed && door_locked) {
      write_string_to_server("ALERT : DOOR OPEN WHILE LOCKED");
      unlock_door();
    }
  }
  byte ls = lift_sensor.readDebounced();
  if (ls!=0){
    lift_present = ls-1;
    write_string_to_server(lift_present?"LIFT HERE":"LIFT AWAY");
  }
  byte cb = call_button.readDebounced();
  if (cb!=0){
    call_button_pressed = cb-1;
    if (call_button_pressed){
      write_string_to_server("call_button_pressed");
    }
  }
}