import React, { useState } from 'react'
import COURSES from './learning-data.json'

// Unique YouTube courses: playlists whose videos are fully contained in another
// were dropped, and overlapping playlists from one channel are merged with each
// video listed once (a lesson's `list` names the playlist it came from). A course
// with `list: null` is a single video. Lesson lists were captured from YouTube and
// are played through YouTube's official embedded player.
// Progress and bookmarks are a per-browser convenience (localStorage).

const plist = c => c.list === undefined ? c.id : c.list
const ytUrl = c => plist(c) ? `https://www.youtube.com/playlist?list=${plist(c)}` : `https://www.youtube.com/watch?v=${c.lessons[0].id}`
const lessonQs = (course, lesson) => { const l = lesson.list || plist(course); return l ? `&list=${l}` : '' }

const store = {
  get(key, fallback) { try { const v = localStorage.getItem('nseid:learn:' + key); return v == null ? fallback : JSON.parse(v) } catch { return fallback } },
  set(key, value) { try { localStorage.setItem('nseid:learn:' + key, JSON.stringify(value)) } catch { /* private mode */ } },
}

function seconds(len) {
  if (!len) return 0
  return len.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0)
}
function hours(total) {
  const h = Math.floor(total / 3600), m = Math.round((total % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

// Player for one course: video, lesson navigation, completion, bookmarks, syllabus.
function CoursePlayer({ course, onProgress }) {
  const n = course.lessons.length
  const [idx, setIdx] = useState(() => Math.min(store.get('pos:' + course.id, 0), n - 1))
  const [done, setDone] = useState(() => new Set(store.get('done:' + course.id, [])))
  const [marks, setMarks] = useState(() => new Set(store.get('marks:' + course.id, [])))
  const lesson = course.lessons[idx]
  const pct = Math.round(done.size / n * 100)
  const go = i => { const j = Math.max(0, Math.min(n - 1, i)); setIdx(j); store.set('pos:' + course.id, j) }
  const toggle = (set, setter, key, id) => {
    const next = new Set(set)
    next.has(id) ? next.delete(id) : next.add(id)
    setter(next); store.set(key + ':' + course.id, [...next])
    if (key === 'done') onProgress()
  }
  return <div className="cp">
    <div className="player-card">
      <div className="player-frame">
        <iframe key={lesson.id} src={`https://www.youtube-nocookie.com/embed/${lesson.id}?rel=0${lessonQs(course, lesson)}`} title={lesson.title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
      </div>
      <div className="player-body">
        <div className="muted">Lesson {idx + 1} / {n}</div>
        <div className="player-title">{lesson.title}</div>
        <div className="player-nav">
          <button className="btn" disabled={idx === 0} onClick={() => go(idx - 1)}>← Previous Lesson</button>
          <button className={'btn complete' + (done.has(lesson.id) ? ' is-done' : '')} onClick={() => toggle(done, setDone, 'done', lesson.id)}>
            {done.has(lesson.id) ? '✓ Completed' : '✓ Mark Complete'}</button>
          <button className="btn" disabled={idx === n - 1} onClick={() => go(idx + 1)}>Next Lesson →</button>
        </div>
        <div className="player-links">
          <button className="link-btn" onClick={() => toggle(marks, setMarks, 'marks', lesson.id)}>{marks.has(lesson.id) ? '★ Bookmarked' : '☆ Bookmark lesson'}</button>
          <a href={`https://www.youtube.com/watch?v=${lesson.id}${lessonQs(course, lesson)}`} target="_blank" rel="noopener noreferrer">Watch on YouTube ↗</a>
        </div>
        <div className="progress"><span style={{ width: pct + '%' }} /></div>
        <div className="muted small">Course progress: <b>{pct}%</b> · {done.size}/{n} lessons · saved in this browser</div>
      </div>
    </div>
    <div className="cp-side">
      <div className="syllabus-h">Lessons <span className="muted small">{n} · {done.size} completed{marks.size ? ` · ${marks.size} bookmarked` : ''}</span></div>
      <ol className="syllabus">
        {course.lessons.map((l, i) => <li key={l.id} className={(i === idx ? 'current ' : '') + (done.has(l.id) ? 'done' : '')}>
          <button onClick={() => go(i)}>
            <span className="ls-num">{done.has(l.id) ? '✓' : i + 1}</span>
            <span className="ls-title">{l.title}{marks.has(l.id) && <span className="ls-mark" title="Bookmarked"> ★</span>}</span>
            <span className="ls-len">{l.len || ''}</span>
          </button>
        </li>)}
      </ol>
      <p className="muted small">▶ Video credit: <a href={ytUrl(course)} target="_blank" rel="noopener noreferrer">{course.channel}</a> (YouTube), via YouTube's official embedded player.</p>
    </div>
  </div>
}

const CATEGORIES = [
  ['buying', 'Option Buying'],
  ['selling', 'Option Selling'],
  ['strategy', 'Strategy'],
  ['screeners', 'Screeners'],
  ['basics', 'Basics', 'stock market, futures & F&O foundations'],
]

export default function Learning() {
  // Course list; clicking a course opens its player (one at a time).
  const [open, setOpen] = useState(() => store.get('open', COURSES[0].id))
  const [, bump] = useState(0)  // re-render list progress after a lesson is marked complete
  const [cat, setCat] = useState(() => store.get('cat', 'buying'))
  const pick = c => { setCat(c); store.set('cat', c) }
  const shown = COURSES.filter(c => c.category === cat)
  const toggle = id => { const next = open === id ? null : id; setOpen(next); store.set('open', next) }
  return <div className="learning-page">
    <div className="page-title"><h1>Learning</h1>
      <span className="muted small">Free stock market, F&O and options courses from YouTube · {COURSES.length} courses · third-party educational content, not advice</span></div>
    <div className="orb-switch learn-cats" role="tablist" aria-label="Course category">
      {CATEGORIES.map(([v, label, sub]) =>
        <button key={v} role="tab" aria-selected={cat === v} className={cat === v ? 'on' : ''} onClick={() => pick(v)}>
          {label}{sub && <small>{sub}</small>}<span className="count">{COURSES.filter(c => c.category === v).length}</span></button>)}
    </div>
    <div className="learn-grid">
      {shown.map(c => {
        const doneN = store.get('done:' + c.id, []).length
        const total = hours(c.lessons.reduce((s, l) => s + seconds(l.len), 0))
        const isOpen = open === c.id
        return <section key={c.id} className={'learn-card' + (isOpen ? ' open' : '')}>
          <div className="learn-head" role="button" tabIndex={0} onClick={() => toggle(c.id)} onKeyDown={e => e.key === 'Enter' && toggle(c.id)}>
            <div>
              <div className="learn-title">{c.title}</div>
              <div className="muted small">{c.channel} · {c.lessons.length} {c.lessons.length === 1 ? "lesson" : "lessons"} · {total} · {c.topic}{doneN ? ` · ${Math.round(doneN / c.lessons.length * 100)}% done` : ''}</div>
            </div>
            <div className="learn-actions">
              <button className="btn sm" onClick={e => { e.stopPropagation(); toggle(c.id) }}>{isOpen ? 'Close' : doneN ? 'Continue' : 'Start'}</button>
              <a className="btn sm" href={ytUrl(c)} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>YouTube ↗</a>
            </div>
          </div>
          {isOpen && <CoursePlayer course={c} onProgress={() => bump(x => x + 1)} />}
        </section>
      })}
    </div>
  </div>
}
