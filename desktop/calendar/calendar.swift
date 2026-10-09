// jelly-calendar: the jelly's diary.
//
// A small command-line helper the shell runs when the assistant looks at or
// adds to your calendar or reminders, through EventKit (the same store the
// Calendar and Reminders apps use). One command per run; it prints one JSON
// value to stdout and exits.
//
//   jelly-calendar events <from> <to>        events in a range
//   jelly-calendar add-event '<json>'        {title, start, end?, allDay?, location?, notes?, calendar?}
//   jelly-calendar reminders                 reminders not yet done
//   jelly-calendar add-reminder '<json>'     {title, due?, notes?, list?}
//
// Dates are local time, "2026-10-09T15:30" (or a date alone for all-day),
// or ISO 8601 with an offset. Errors come back as {"error": "…"}.
//
// Build: swiftc -O -o desktop/bin/jelly-calendar desktop/calendar/calendar.swift

import EventKit
import Foundation

func out(_ value: Any) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}
func fail(_ message: String) -> Never { out(["error": message]) }

let store = EKEventStore()

func access(_ type: EKEntityType) {
  let done = DispatchSemaphore(value: 0)
  var granted = false
  let finish: (Bool, Error?) -> Void = { ok, _ in granted = ok; done.signal() }
  if #available(macOS 14.0, *) {
    if type == .event { store.requestFullAccessToEvents(completion: finish) }
    else { store.requestFullAccessToReminders(completion: finish) }
  } else {
    store.requestAccess(to: type, completion: finish)
  }
  done.wait()
  if !granted {
    fail(type == .event
      ? "Sticky Jelly isn't allowed to use your calendar. Allow it in System Settings › Privacy & Security › Calendars."
      : "Sticky Jelly isn't allowed to use your reminders. Allow it in System Settings › Privacy & Security › Reminders.")
  }
}

/* "2026-10-09T15:30", "2026-10-09 15:30", "2026-10-09", or ISO 8601 with a zone. */
func parse(_ s: String) -> (Date, Bool)? {
  let iso = ISO8601DateFormatter()
  iso.formatOptions = [.withInternetDateTime]
  if let d = iso.date(from: s) { return (d, false) }
  let f = DateFormatter()
  f.locale = Locale(identifier: "en_US_POSIX")
  f.timeZone = .current
  for (fmt, dateOnly) in [("yyyy-MM-dd'T'HH:mm:ss", false), ("yyyy-MM-dd'T'HH:mm", false), ("yyyy-MM-dd HH:mm", false), ("yyyy-MM-dd", true)] {
    f.dateFormat = fmt
    if let d = f.date(from: s) { return (d, dateOnly) }
  }
  return nil
}

func local(_ d: Date) -> String {
  let f = DateFormatter()
  f.locale = Locale(identifier: "en_US_POSIX")
  f.timeZone = .current
  f.dateFormat = "yyyy-MM-dd'T'HH:mm"
  return f.string(from: d)
}

func json(_ s: String) -> [String: Any] {
  guard let d = s.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
    fail("That wasn't valid JSON.")
  }
  return o
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("No command.") }

switch command {
case "events":
  access(.event)
  guard args.count >= 3, let (from, _) = parse(args[1]), let (to, toDateOnly) = parse(args[2]) else {
    fail("Give a start and an end, like 2026-10-09 and 2026-10-10.")
  }
  // A date alone as the end means "through the end of that day".
  let end = toDateOnly ? Calendar.current.date(byAdding: .day, value: 1, to: to)! : to
  let predicate = store.predicateForEvents(withStart: from, end: end, calendars: nil)
  let events = store.events(matching: predicate)
    .sorted { $0.startDate < $1.startDate }
    .prefix(100)
    .map { e -> [String: Any] in
      var o: [String: Any] = [
        "title": e.title ?? "(no title)",
        "start": local(e.startDate),
        "end": local(e.endDate),
        "allDay": e.isAllDay,
        "calendar": e.calendar?.title ?? "",
      ]
      if let l = e.location, !l.isEmpty { o["location"] = l }
      return o
    }
  out(["events": Array(events)])

case "add-event":
  access(.event)
  guard args.count >= 2 else { fail("Nothing to add.") }
  let o = json(args[1])
  guard let title = o["title"] as? String, !title.isEmpty else { fail("An event needs a title.") }
  guard let s = o["start"] as? String, let (start, dateOnly) = parse(s) else { fail("An event needs a start, like 2026-10-10T13:00.") }
  let e = EKEvent(eventStore: store)
  e.title = title
  e.startDate = start
  let allDay = (o["allDay"] as? Bool) ?? dateOnly
  e.isAllDay = allDay
  if let es = o["end"] as? String, let (end, _) = parse(es) { e.endDate = end }
  else { e.endDate = allDay ? start : start.addingTimeInterval(3600) }
  if let l = o["location"] as? String { e.location = l }
  if let n = o["notes"] as? String { e.notes = n }
  if let name = o["calendar"] as? String,
     let cal = store.calendars(for: .event).first(where: { $0.title.caseInsensitiveCompare(name) == .orderedSame && $0.allowsContentModifications }) {
    e.calendar = cal
  } else {
    e.calendar = store.defaultCalendarForNewEvents
  }
  guard e.calendar != nil else { fail("There's no calendar to add it to.") }
  do { try store.save(e, span: .thisEvent) } catch { fail("Couldn't save the event: \(error.localizedDescription)") }
  out(["added": ["title": title, "start": local(e.startDate), "end": local(e.endDate), "calendar": e.calendar.title]])

case "reminders":
  access(.reminder)
  let done = DispatchSemaphore(value: 0)
  var items: [[String: Any]] = []
  let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
  store.fetchReminders(matching: predicate) { reminders in
    items = (reminders ?? []).prefix(100).map { r in
      var o: [String: Any] = ["title": r.title ?? "(no title)", "list": r.calendar?.title ?? ""]
      if let c = r.dueDateComponents, let d = Calendar.current.date(from: c) { o["due"] = local(d) }
      return o
    }
    done.signal()
  }
  done.wait()
  out(["reminders": items])

case "add-reminder":
  access(.reminder)
  guard args.count >= 2 else { fail("Nothing to add.") }
  let o = json(args[1])
  guard let title = o["title"] as? String, !title.isEmpty else { fail("A reminder needs a title.") }
  let r = EKReminder(eventStore: store)
  r.title = title
  if let n = o["notes"] as? String { r.notes = n }
  if let name = o["list"] as? String,
     let cal = store.calendars(for: .reminder).first(where: { $0.title.caseInsensitiveCompare(name) == .orderedSame }) {
    r.calendar = cal
  } else {
    r.calendar = store.defaultCalendarForNewReminders()
  }
  guard r.calendar != nil else { fail("There's no reminders list to add it to.") }
  var due: String? = nil
  if let ds = o["due"] as? String, let (d, dateOnly) = parse(ds) {
    let parts: Set<Calendar.Component> = dateOnly ? [.year, .month, .day] : [.year, .month, .day, .hour, .minute]
    r.dueDateComponents = Calendar.current.dateComponents(parts, from: d)
    if !dateOnly { r.addAlarm(EKAlarm(absoluteDate: d)) }
    due = local(d)
  }
  do { try store.save(r, commit: true) } catch { fail("Couldn't save the reminder: \(error.localizedDescription)") }
  var added: [String: Any] = ["title": title, "list": r.calendar.title]
  if let due { added["due"] = due }
  out(["added": added])

default:
  fail("Unknown command \(command).")
}
