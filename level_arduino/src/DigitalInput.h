#ifndef DIGITALINPUT_H
#define DIGITALINPUT_H

#include <Arduino.h>

class DigitalInput
{
  
private:
  byte pin;
  bool pull_up;
  bool reversed_output=false;
  bool state;
  bool last_state_out;
  unsigned long lastDebounceTime = 0;
  unsigned long now = 0;
  const unsigned long debounceDelay = 50;

public:
  DigitalInput(){} // dummy for easy compilation, do nbot use
  DigitalInput(byte pin)
  {
    this->pin = pin;
    this->pull_up = false;
  } 
  DigitalInput(byte pin, bool pull_up)
  {
    this->pin = pin;
    this->pull_up = pull_up;
  }
  DigitalInput(byte pin, bool pull_up, bool reversed_output)
  {
    this->pin = pin;
    this->pull_up = pull_up;
    this->reversed_output = reversed_output;
  }
  void init()
  {
    // pull up or no pull up
    if (pull_up) pinMode(pin,INPUT_PULLUP);
    else pinMode(pin,INPUT);
    //init state value to current state to properly output the 1st value next time reading changes
    state = digitalRead(pin)==(reversed_output)?LOW:HIGH;
    last_state_out = state;
    // Serial.print("--- ");
    // Serial.println(pin);
  }
  byte readDebounced()
  {
    // update time
    now = millis();
    // read state
    bool new_state = digitalRead(pin)==(reversed_output)?LOW:HIGH;
    // if value changed start timer
    if (state!=new_state){
      lastDebounceTime = now;
      state = new_state;
    }
    // if timer reaches debounceDelay, stop timer
    if (lastDebounceTime && now-lastDebounceTime>debounceDelay){
      lastDebounceTime = 0;
      // if confirmed state different from last one out, send it out
      if (last_state_out != state){
        last_state_out = state;
        return state+1;
      }
    }
    // else send 0 for no activity
    return 0;
  }
  byte readNow(){
    return digitalRead(pin)==(reversed_output)?LOW:HIGH;
  }
  byte getPin()
  {
    return pin;
  }
};


#endif