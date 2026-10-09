// jelly-listen: the jelly's ears.
//
// A tiny command-line helper the shell runs while you talk. It listens on the
// default microphone, transcribes with Apple's speech recognizer — on the
// device when the language supports it — and writes one JSON object per line
// to stdout:
//
//   {"type":"ready"}                     listening
//   {"type":"level","value":0.42}        loudness, 0…1, a few times a second
//   {"type":"partial","text":"…"}        the transcript so far
//   {"type":"final","text":"…"}          done; the process exits after this
//   {"type":"error","message":"…"}       could not listen; exits after this
//
// It stops on its own after a pause once you have said something, after a
// few seconds if you say nothing, or when "stop" arrives on stdin.
//
// Build: swiftc -O -o desktop/bin/jelly-listen desktop/listen/listen.swift

import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)
let out = DispatchQueue(label: "out")

func emit(_ obj: [String: Any]) {
  out.sync {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
  }
}

func fail(_ message: String) -> Never {
  emit(["type": "error", "message": message])
  exit(1)
}

let SILENCE_AFTER_SPEECH = 1.6   // seconds of no new words before it sends
let NOTHING_SAID = 8.0           // give up if nothing is heard at all
let LONGEST = 60.0               // hard stop

let recognizer: SFSpeechRecognizer? = CommandLine.arguments.count > 1
  ? SFSpeechRecognizer(locale: Locale(identifier: CommandLine.arguments[1]))
  : SFSpeechRecognizer()

let engine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
request.addsPunctuation = true

var transcript = ""
var lastChange = Date()
var started = Date()
var heard = false
var stopping = false
var done = false
var lastLevel = Date.distantPast
var task: SFSpeechRecognitionTask?

func finish(_ text: String) {
  if done { return }
  done = true
  emit(["type": "final", "text": text])
  exit(0)
}

/* Stop listening; the recognizer then delivers its last result, or we give
   it a moment and send what we have. */
func stop() {
  if stopping { return }
  stopping = true
  engine.stop()
  engine.inputNode.removeTap(onBus: 0)
  request.endAudio()
  DispatchQueue.main.asyncAfter(deadline: .now() + 2) { finish(transcript) }
}

func listen() {
  guard let recognizer, recognizer.isAvailable else {
    fail("Speech recognition isn't available for this language right now.")
  }
  if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }

  let input = engine.inputNode
  let format = input.outputFormat(forBus: 0)
  input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    request.append(buffer)
    // Loudness for the mic blob to pulse with: RMS in dB, mapped to 0…1.
    let now = Date()
    guard now.timeIntervalSince(lastLevel) > 0.06, let ch = buffer.floatChannelData?[0] else { return }
    lastLevel = now
    let n = Int(buffer.frameLength)
    var sum: Float = 0
    for i in 0..<n { sum += ch[i] * ch[i] }
    let rms = sqrt(sum / Float(max(n, 1)))
    let db = 20 * log10(max(rms, 1e-6))
    let level = min(1, max(0, (db + 55) / 40))
    emit(["type": "level", "value": Double(level)])
  }
  engine.prepare()
  do { try engine.start() } catch { fail("Couldn't start the microphone.") }
  started = Date()
  emit(["type": "ready"])

  task = recognizer.recognitionTask(with: request) { result, error in
    if let result {
      let text = result.bestTranscription.formattedString
      if text != transcript {
        transcript = text
        lastChange = Date()
        heard = true
        emit(["type": "partial", "text": text])
      }
      if result.isFinal { DispatchQueue.main.async { finish(text) } }
    }
    if error != nil {
      // "No speech detected" and friends: hand back whatever we caught.
      DispatchQueue.main.async { finish(transcript) }
    }
  }

  Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
    let now = Date()
    if heard && now.timeIntervalSince(lastChange) > SILENCE_AFTER_SPEECH { stop() }
    if !heard && now.timeIntervalSince(started) > NOTHING_SAID { stop() }
    if now.timeIntervalSince(started) > LONGEST { stop() }
  }
}

/* "stop" on stdin (or stdin closing — the app went away) ends it early. */
DispatchQueue.global().async {
  while let line = readLine() {
    if line.trimmingCharacters(in: .whitespaces) == "stop" { DispatchQueue.main.async { stop() } }
  }
  DispatchQueue.main.async { if !stopping { stop() } }
}

SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else {
    fail("Sticky Jelly needs Speech Recognition. Allow it in System Settings › Privacy & Security › Speech Recognition.")
  }
  AVCaptureDevice.requestAccess(for: .audio) { granted in
    guard granted else {
      fail("Sticky Jelly needs the microphone. Allow it in System Settings › Privacy & Security › Microphone.")
    }
    DispatchQueue.main.async { listen() }
  }
}

RunLoop.main.run()
