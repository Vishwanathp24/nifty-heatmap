import React, { useEffect, useMemo, useState } from 'react'
import COURSES from './learning-data.json'

// Five unique YouTube playlists (two shared links were dropped: their videos are
// fully contained in a longer playlist from the same channel). Lesson lists were
// captured from YouTube and are played through YouTube's official embedded player.
// Progress and bookmarks are a per-browser convenience (localStorage).

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

export default function Learning() {
  const [courseId, setCourseId] = useState(() => store.get('course', COURSES[0].id))
  const course = COURSES.find(c => c.id === courseId) || COURSES[0]
  const n = course.lessons.length
  const [idx, setIdx] = useState(() => Math.min(store.get('pos:' + course.id, 0), n - 1))
  const [done, setDone] = useState(() => new Set(store.get('done:' + course.id, [])))
  const [marks, setMarks] = useState(() => new Set(store.get('marks:' + course.id, [])))

  // switching course: restore that course's position, progress and bookmarks
  useEffect(() => {
    store.set('course', course.id)
    setIdx(Math.min(store.get('pos:' + course.id, 0), n - 1))
    setDone(new Set(store.get('done:' + course.id, [])))
    setMarks(new Set(store.get('marks:' + course.id, [])))
  }, [course.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const lesson = course.lessons[idx]
  const total = useMemo(() => hours(course.lessons.reduce((s, l) => s + seconds(l.len), 0)), [course])
  const pct = Math.round(done.size / n * 100)
  const go = i => { const j = Math.max(0, Math.min(n - 1, i)); setIdx(j); store.set('pos:' + course.id, j) }
  const toggle = (set, setter, key, id) => {
    const next = new Set(set)
    next.has(id) ? next.delete(id) : next.add(id)
    setter(next); store.set(key + ':' + course.id, [...next])
  }
  const firstOpen = course.lessons.findIndex(l => !done.has(l.id))

  return <div className="learning-page">
    <div className="page-title"><h1>Learning</h1>
      <span className="muted small">Free F&O and options courses from YouTube · third-party educational content, not advice</span></div>

    <div className="course-tabs" role="tablist">
      {COURSES.map(c => <button key={c.id} role="tab" aria-selected={c.id === course.id} className={c.id === course.id ? 'on' : ''} onClick={() => setCourseId(c.id)}>
        <span className="ct-title">{c.title}</span><span className="ct-sub">{c.channel} · {c.lessons.length} lessons</span>
      </button>)}
    </div>

    <div className="course-layout">
      <div className="course-info">
        <span className="course-chip">{course.topic}</span>
        <h2 className="course-title">{course.title}</h2>
        <p className="course-summary">{course.summary}</p>
        <p className="muted">Instructor: <a href={`https://www.youtube.com/playlist?list=${course.id}`} target="_blank" rel="noopener noreferrer">{course.channel}</a></p>
        <div className="course-stats">
          <div><div className="k">Lessons</div><div className="v">{n}</div></div>
          <div><div className="k">Duration</div><div className="v">{total}</div></div>
          <div><div className="k">Source</div><div className="v">YouTube Playlist</div></div>
          <div><div className="k">Price</div><div className="v">Free</div></div>
        </div>
        <div className="course-cta">
          <button className="btn primary" onClick={() => go(firstOpen >= 0 ? firstOpen : 0)}>{done.size ? 'Continue Learning' : 'Start Learning'}</button>
          <a className="btn" href={`https://www.youtube.com/playlist?list=${course.id}`} target="_blank" rel="noopener noreferrer">Playlist on YouTube ↗</a>
        </div>
        <h3 className="syllabus-h">Course Syllabus <span className="muted small">{n} lessons · {done.size} completed{marks.size ? ` · ${marks.size} bookmarked` : ''}</span></h3>
        <ol className="syllabus">
          {course.lessons.map((l, i) => <li key={l.id} className={(i === idx ? 'current ' : '') + (done.has(l.id) ? 'done' : '')}>
            <button onClick={() => go(i)}>
              <span className="ls-num">{done.has(l.id) ? '✓' : i + 1}</span>
              <span className="ls-title">{l.title}{marks.has(l.id) && <span className="ls-mark" title="Bookmarked"> ★</span>}</span>
              <span className="ls-len">{l.len || ''}</span>
            </button>
          </li>)}
        </ol>
      </div>

      <div className="player-col">
        <div className="player-card">
          <div className="player-frame">
            <iframe key={lesson.id} src={`https://www.youtube-nocookie.com/embed/${lesson.id}?rel=0&list=${course.id}`} title={lesson.title}
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
              <a href={`https://www.youtube.com/watch?v=${lesson.id}&list=${course.id}`} target="_blank" rel="noopener noreferrer">Watch on YouTube ↗</a>
            </div>
            <div className="progress"><span style={{ width: pct + '%' }} /></div>
            <div className="muted small">Course progress: <b>{pct}%</b> · {done.size}/{n} lessons · saved in this browser</div>
          </div>
        </div>
        <p className="muted small">▶ Video credit: <a href={`https://www.youtube.com/playlist?list=${course.id}`} target="_blank" rel="noopener noreferrer">{course.channel}</a> (YouTube). Played through YouTube's official embedded player.</p>
      </div>
    </div>
  </div>
}
