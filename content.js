// Content script: reads the Moodle grader page (mod/assign/view.php?action=grader)
// and fetches submission files with the user's Moodle session.
(() => {
  if (window.__moodleGraderAssistant) return;
  window.__moodleGraderAssistant = true;

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const text = (el) => clean(el && el.textContent);
  const param = (href, name) => {
    try { return new URL(href, location.href).searchParams.get(name); } catch (_) { return null; }
  };

  function isGrader() {
    const u = new URL(location.href);
    return /\/mod\/assign\/view\.php$/.test(u.pathname) && u.searchParams.get('action') === 'grader';
  }

  // "מטלה 3", "מטלה מס' 3", "Assignment 3", "תרגיל בית 3", "שבוע 3" ...
  function parseAssignmentNumber(title) {
    const patterns = [
      /מטלה\s*(?:מס(?:פר|['׳.])?\s*)?(\d+)/,
      /(?:תרגיל(?:\s*בית)?|שבוע|שיעור)\s*(?:מס(?:פר|['׳.])?\s*)?(\d+)/,
      /(?:assignment|homework|hw|ex(?:ercise)?|week|lesson)\s*#?\s*(\d+)/i,
      /(\d+)/,
    ];
    for (const re of patterns) {
      const m = re.exec(title || '');
      if (m) return m[1];
    }
    return '';
  }

  function getAssignmentInfo() {
    const box = document.querySelector('[data-region="assignment-info"]');
    let title = '';
    let courseId = '';
    if (box) {
      const a = [...box.querySelectorAll('a[href*="/mod/assign/view.php"]')].find((x) => text(x));
      title = a ? text(a) : '';
      const c = box.querySelector('a[href*="/course/view.php"]');
      if (c) courseId = param(c.href, 'id') || '';
    }
    if (!title) {
      const h = document.querySelector('.page-header-headings h1, h1, h2');
      title = text(h) || clean(document.title.split(/[:|]/).pop());
    }
    return { title, courseId };
  }

  function getUserInfo() {
    const box = document.querySelector('[data-region="user-info"]');
    if (!box) return { name: '', linkUserId: '' };
    const links = [...box.querySelectorAll('a[href*="/user/view.php"], a[href*="/user/profile.php"]')];
    const named = links.find((a) => text(a));
    if (named) return { name: text(named), linkUserId: param(named.href, 'id') || '' };
    const h = box.querySelector('[data-region*="fullname"], h4, .h4, h3, .h3, h5');
    const any = links[0];
    return { name: text(h), linkUserId: any ? param(any.href, 'id') || '' : '' };
  }

  function getSubmissionFiles() {
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href*="/pluginfile.php/"]')) {
      if (!/\/assignsubmission_file\/submission_files\//.test(a.href)) continue;
      const url = a.href.replace(/([?&])forcedownload=1&?/, '$1').replace(/[?&]$/, '');
      const key = url.split('?')[0];
      if (seen.has(key)) continue;
      let name = text(a);
      const last = decodeURIComponent(key.split('/').pop() || '');
      if (!name || !/\.[A-Za-z0-9]{1,6}$/.test(name)) name = last;
      seen.set(key, { name, url: key + '?forcedownload=1' });
    }
    return [...seen.values()];
  }

  function getOnlineText() {
    const nodes = [...document.querySelectorAll(
      '[class*="onlinetext"], [id*="onlinetext"], [data-plugin="onlinetext"], [data-region="submission-onlinetext"]'
    )];
    let best = '';
    for (const n of nodes) {
      const t = (n.innerText || '').trim();
      if (t.length > best.length) best = t;
    }
    return best;
  }

  async function fetchProfileName(userid, courseId) {
    try {
      const url = `/user/view.php?id=${encodeURIComponent(userid)}${courseId ? '&course=' + courseId : ''}`;
      const html = await (await fetch(url, { credentials: 'include' })).text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return text(doc.querySelector('.page-header-headings h1, .page-context-header h2, h1'));
    } catch (_) {
      return '';
    }
  }

  async function getContext() {
    if (!isGrader()) return { isGrader: false, url: location.href };
    const u = new URL(location.href);
    const assignment = getAssignmentInfo();
    const user = getUserInfo();
    const userid = u.searchParams.get('userid') || user.linkUserId || '';
    let studentName = user.name;
    // While the grader is switching students the old user's panel may still be visible.
    const inSync = !user.linkUserId || !userid || user.linkUserId === userid;
    if ((!studentName || !inSync) && userid) studentName = await fetchProfileName(userid, assignment.courseId);
    return {
      isGrader: true,
      url: location.href,
      cmid: u.searchParams.get('id') || '',
      userid,
      courseId: assignment.courseId,
      assignmentTitle: assignment.title,
      assignmentNumber: parseAssignmentNumber(assignment.title),
      studentName,
      files: inSync ? getSubmissionFiles() : [],
      onlineText: inSync ? getOnlineText() : '',
      loading: !inSync || !document.querySelector('[data-region="grade-panel"]'),
    };
  }

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function fetchFile(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} עבור ${url}`);
    const type = res.headers.get('content-type') || '';
    const buf = await res.arrayBuffer();
    if (/text\/html/.test(type) && /login/i.test(res.url)) throw new Error('נראה שפג תוקף ההתחברות ל-Moodle');
    return { base64: toBase64(buf), size: buf.byteLength, type };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'GET_CONTEXT') {
      getContext().then(sendResponse, (e) => sendResponse({ error: e.message }));
      return true;
    }
    if (msg.type === 'FETCH_FILE') {
      fetchFile(msg.url).then(sendResponse, (e) => sendResponse({ error: e.message }));
      return true;
    }
  });

  // The grader is a single-page app: notify the side panel when the student/page changes.
  let lastSig = '';
  setInterval(() => {
    if (!isGrader()) return;
    const sig = [location.href, getUserInfo().name, getSubmissionFiles().map((f) => f.url).join(',')].join('|');
    if (sig !== lastSig) {
      lastSig = sig;
      try {
        chrome.runtime.sendMessage({ type: 'CONTEXT_CHANGED' }).catch(() => {});
      } catch (_) { /* extension was reloaded; this old script is orphaned */ }
    }
  }, 1000);
})();
