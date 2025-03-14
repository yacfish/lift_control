#include <Arduino.h>
#include "DigitalInput.h"

const String client_id = "2"; // 'B' or 'G' or '1' or '2'

//inputs
DigitalInput door_sensor(2,true,true); // end switch
DigitalInput lift_sensor(3,false,true); // digital IR sensor
DigitalInput call_button(4,true,true); // end switch

//outputs
const int magnetic_lock_pin = 6; // SSR -> 12v magnetic lock  

//state variables
bool door_closed = false;
bool door_locked = false;
bool door_lock_requested = false;
bool lift_present = false;
bool call_button_pressed = false;
bool calibrartion_status = false;
////////////////////////////////////////////////////////////////////
// CUSTOM FUNCTIONS

String read_string_from_server() {
  String _str = Serial.readStringUntil('\n');
  int lastIndex = _str.length() - 1;
  _str.remove(lastIndex);
  return _str;
} 

void write_string_to_server(String mess) {
  Serial.println(client_id+" : "+mess);
}

void lock_if_requested_and_closed() {
  if (door_lock_requested && door_closed){
    digitalWrite(LED_BUILTIN, HIGH);
    door_locked = true;
    write_string_to_server("DOOR LOCKED");
    door_lock_requested=false;
  }
}

void lock_door_request() {
  door_lock_requested = true;
  write_string_to_server("DOOR LOCK REQUESTED");
  lock_if_requested_and_closed();
}

void unlock_door() {
  door_lock_requested = false;
  digitalWrite(LED_BUILTIN, LOW);
  door_locked = false;
  write_string_to_server("DOOR UNLOCKED");
}
////////////////////////////////////////////////////////////////////
// SETUP & LOOP
void setup() {
  Serial.begin(57600);
  pinMode(LED_BUILTIN, OUTPUT);
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
}

void loop() {
  delay(1);

  if (Serial.available() > 0) {
    String cmd_str = read_string_from_server();
    if (cmd_str=="UNLOCK_DOOR"){unlock_door();}
    else if (cmd_str=="LOCK_DOOR_REQUEST"){lock_door_request();}
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
      if (!lift_present && door_closed && door_locked) write_string_to_server("COME TO ME");
      else write_string_to_server("FORBIDEN CALL");
    }
  }
}

