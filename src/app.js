import { h, render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import LightningFS from '@isomorphic-git/lightning-fs';
import { marked } from 'marked';
import Prism from 'prismjs';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markup'; // html, xml, svg
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-java';

const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
  css: 'css', scss: 'css',
  json: 'json',
  md: 'markdown', markdown: 'markdown',
  sh: 'bash', bash: 'bash',
  py: 'python',
  yml: 'yaml', yaml: 'yaml',
  rs: 'rust',
  go: 'go',
  java: 'java',
};

function detectLanguage(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const lang = LANG_BY_EXT[ext];
  return lang && Prism.languages[lang] ? lang : null;
}

const FILE_ICON_BY_EXT = {
  js: '\u{1F7E8}', mjs: '\u{1F7E8}', cjs: '\u{1F7E8}',
  jsx: '⚛️', tsx: '⚛️',
  ts: '\u{1F7E6}',
  html: '\u{1F310}', htm: '\u{1F310}',
  css: '\u{1F3A8}', scss: '\u{1F3A8}',
  json: '\u{1F4CB}',
  md: '\u{1F4DD}', markdown: '\u{1F4DD}',
  py: '\u{1F40D}',
  rs: '\u{1F980}',
  go: '\u{1F439}',
  java: '☕',
  yml: '⚙️', yaml: '⚙️',
  sh: '\u{1F41A}', bash: '\u{1F41A}',
  png: '\u{1F5BC}️', jpg: '\u{1F5BC}️', jpeg: '\u{1F5BC}️',
  gif: '\u{1F5BC}️', svg: '\u{1F5BC}️', webp: '\u{1F5BC}️',
  pdf: '\u{1F4D5}',
  zip: '\u{1F4E6}', tar: '\u{1F4E6}', gz: '\u{1F4E6}',
};

const SPECIAL_NAME_ICON = {
  'README.md': '\u{1F4D6}', 'README': '\u{1F4D6}', 'README.markdown': '\u{1F4D6}',
  'LICENSE': '⚖️', 'LICENSE.md': '⚖️',
  'COPYING': '⚖️', 'COPYING.md': '⚖️',
  '.gitignore': '\u{1F6AB}', '.env': '\u{1F510}',
  'package.json': '\u{1F4E6}', 'Dockerfile': '\u{1F433}',
};

function fileIcon(name, type) {
  if (type === 'tree') return '\u{1F4C1}';
  if (SPECIAL_NAME_ICON[name]) return SPECIAL_NAME_ICON[name];
  const ext = name.split('.').pop().toLowerCase();
  return FILE_ICON_BY_EXT[ext] || '\u{1F4C4}';
}

function highlight(code, lang) {
  if (!lang) return null;
  try {
    return Prism.highlight(code, Prism.languages[lang], lang);
  } catch {
    return null;
  }
}

const html = htm.bind(h);

const fs = new LightningFS('jss-git', { wipe: true });
const dir = '/repo';

const MD_RE = /\.(md|markdown)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i;
const MAX_TEXT_BYTES = 512 * 1024;
const HISTORY_DEPTH = 50;

function isLikelyText(bytes) {
  const sample = bytes.slice(0, Math.min(bytes.length, 8192));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return false;
  }
  return true;
}

function relativeTime(seconds) {
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
  return `${Math.floor(diff / (86400 * 365))}y ago`;
}

function parseRepoUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    // Take the last two segments of the URL path as owner/repo.
    // Faithful to URL structure; mimics GitHub's owner/repo display
    // without inventing an "owner" not present in the URL.
    const repo = (parts[parts.length - 1] || u.hostname).replace(/\.git$/, '');
    const owner = parts[parts.length - 2] || u.hostname;
    return { owner, repo };
  } catch {
    return { owner: '', repo: rawUrl };
  }
}

function App() {
  const params = new URLSearchParams(location.search);
  const initialUrl = params.get('repo') || '';
  const initialPath = params.get('path') || '';
  const initialView = params.get('view') || 'files';
  const initialBranch = params.get('branch') || '';
  const initialCommit = params.get('commit') || '';

  const [url, setUrl] = useState(initialUrl);
  const [path, setPath] = useState(initialPath);
  const [view, setView] = useState(initialView);
  const [refs, setRefs] = useState(null);
  const [tree, setTree] = useState(null);
  const [subTree, setSubTree] = useState(null); // entries when in a subfolder
  const [readmeHtml, setReadmeHtml] = useState(null);
  const [fileView, setFileView] = useState(null);
  const [commits, setCommits] = useState(null);
  const [historyFetched, setHistoryFetched] = useState(false);
  const [latestCommit, setLatestCommit] = useState(null);
  const [commitDetail, setCommitDetail] = useState(null);
  const [selectedCommit, setSelectedCommit] = useState(initialCommit);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [repoReady, setRepoReady] = useState(false);
  const [branch, setBranch] = useState(null);

  const loadCommitDetail = async (oid) => {
    setError(null);
    setCommitDetail(null);
    try {
      const result = await git.readCommit({ fs, dir, oid });
      const commit = result.commit;
      const parentOids = commit.parent || [];

      // Compute changed files vs parent (or all files for initial commit)
      let files = [];
      if (parentOids.length > 0) {
        const parentOid = parentOids[0];
        const parentCommit = await git.readCommit({ fs, dir, oid: parentOid });
        const parentTreeOid = parentCommit.commit.tree;
        const treeOid = commit.tree;

        // Walk both trees and diff
        const collected = await git.walk({
          fs, dir,
          trees: [
            git.TREE({ ref: parentTreeOid }),
            git.TREE({ ref: treeOid }),
          ],
          map: async function (filepath, entries) {
            if (filepath === '.') return;
            const [parent, current] = entries;
            if (!parent && current) {
              if ((await current.type()) !== 'blob') return;
              return { path: filepath, change: 'added' };
            }
            if (parent && !current) {
              if ((await parent.type()) !== 'blob') return;
              return { path: filepath, change: 'deleted' };
            }
            if (parent && current) {
              if ((await current.type()) !== 'blob') return;
              const a = await parent.oid();
              const b = await current.oid();
              if (a !== b) return { path: filepath, change: 'modified' };
            }
          },
        });
        files = collected.filter(Boolean);
      } else {
        // Initial commit — list all files in tree
        const collected = await git.walk({
          fs, dir,
          trees: [git.TREE({ ref: commit.tree })],
          map: async function (filepath, [entry]) {
            if (filepath === '.') return;
            if (!entry) return;
            if ((await entry.type()) !== 'blob') return;
            return { path: filepath, change: 'added' };
          },
        });
        files = collected.filter(Boolean);
      }

      files.sort((a, b) => a.path.localeCompare(b.path));
      setCommitDetail({ oid, commit, parents: parentOids, files });
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  const loadFolder = async (folderPath) => {
    const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    const { tree: subEntries } = await git.readTree({ fs, dir, oid: headOid, filepath: folderPath });
    subEntries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    setSubTree(subEntries);
    setFileView(null);
  };

  const loadPath = async (p) => {
    setError(null);
    setSubTree(null);
    setFileView(null);
    if (!p) return;
    try {
      // Try folder first; if that throws "not a tree" or similar, try file
      await loadFolder(p);
    } catch (folderErr) {
      try {
        await loadFile(p);
      } catch (e) {
        setError(e.message || String(e));
      }
    }
  };

  const loadFile = async (filePath) => {
    setError(null);
    setFileView(null);
    if (!filePath) return;
    try {
      const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
      const { blob, oid } = await git.readBlob({ fs, dir, oid: headOid, filepath: filePath });

      if (IMAGE_RE.test(filePath)) {
        let binary = '';
        for (let i = 0; i < blob.length; i++) binary += String.fromCharCode(blob[i]);
        const ext = filePath.split('.').pop().toLowerCase();
        const mime = ext === 'svg' ? 'image/svg+xml'
                   : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                   : `image/${ext}`;
        setFileView({ kind: 'image', src: `data:${mime};base64,${btoa(binary)}`, path: filePath, oid });
        return;
      }

      if (blob.length > MAX_TEXT_BYTES) {
        setFileView({ kind: 'too-large', size: blob.length, path: filePath, oid });
        return;
      }

      if (!isLikelyText(blob)) {
        setFileView({ kind: 'binary', size: blob.length, path: filePath, oid });
        return;
      }

      const text = new TextDecoder().decode(blob);

      if (MD_RE.test(filePath)) {
        setFileView({ kind: 'markdown', html: marked.parse(text), path: filePath, oid });
      } else {
        const lang = detectLanguage(filePath);
        const highlighted = lang ? highlight(text, lang) : null;
        setFileView({ kind: 'text', text, html: highlighted, lang, path: filePath, oid });
      }
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  const loadCommits = async () => {
    if (commitsLoading) return;
    setCommitsLoading(true);
    setError(null);
    try {
      if (!historyFetched && branch) {
        await git.fetch({
          fs, http, dir,
          singleBranch: true,
          depth: HISTORY_DEPTH,
          ref: branch,
        });
        setHistoryFetched(true);
      }
      const log = await git.log({ fs, dir, depth: HISTORY_DEPTH });
      setCommits(log);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setCommitsLoading(false);
    }
  };

  const loadRepo = async (repoUrl) => {
    if (!repoUrl) return;
    setLoading(true);
    setError(null);
    setRefs(null);
    setTree(null);
    setReadmeHtml(null);
    setFileView(null);
    setCommits(null);
    setHistoryFetched(false);
    setLatestCommit(null);
    setRepoReady(false);

    try {
      const refsResult = await git.listServerRefs({ http, url: repoUrl });
      setRefs(refsResult);

      if (refsResult.length === 0) {
        setLoading(false);
        return;
      }

      let resolvedBranch = initialBranch;
      if (!resolvedBranch) {
        const headRef = refsResult.find(r => r.ref === 'HEAD');
        resolvedBranch = headRef?.target?.replace(/^refs\/heads\//, '');
        if (!resolvedBranch) {
          const firstHead = refsResult.find(r => r.ref.startsWith('refs/heads/'));
          resolvedBranch = firstHead?.ref.replace(/^refs\/heads\//, '');
        }
      }
      if (!resolvedBranch) {
        setLoading(false);
        return;
      }
      setBranch(resolvedBranch);

      await git.clone({
        fs, http, dir,
        url: repoUrl,
        singleBranch: true,
        depth: 1,
        ref: resolvedBranch,
      });

      const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });

      const headCommit = await git.readCommit({ fs, dir, oid: headOid });
      setLatestCommit({
        oid: headOid,
        author: headCommit.commit.author.name,
        message: headCommit.commit.message.split('\n')[0],
        timestamp: headCommit.commit.author.timestamp,
      });

      const { tree: treeEntries } = await git.readTree({ fs, dir, oid: headCommit.commit.tree });
      treeEntries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
        return a.path.localeCompare(b.path);
      });
      setTree(treeEntries);

      const readmeEntry = treeEntries.find(
        e => e.type === 'blob' && /^README(\.md|\.markdown)?$/i.test(e.path)
      );
      if (readmeEntry) {
        const { blob } = await git.readBlob({ fs, dir, oid: readmeEntry.oid });
        const text = new TextDecoder().decode(blob);
        setReadmeHtml(marked.parse(text));
      }

      setRepoReady(true);

      // Update document title for browser tab + bookmarks
      const { owner, repo } = parseRepoUrl(repoUrl);
      document.title = `${owner}/${repo} · JSS Git`;

      if (path) await loadPath(path);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (initialUrl) loadRepo(initialUrl); }, []);

  // When view switches to commits and repo is ready, lazy-load commits
  useEffect(() => {
    if (view === 'commits' && repoReady && !commits && !commitsLoading) {
      loadCommits();
    }
  }, [view, repoReady]);

  const updateUrl = (next) => {
    const p = new URLSearchParams();
    if (next.repo) p.set('repo', next.repo);
    if (next.path) p.set('path', next.path);
    if (next.view && next.view !== 'files') p.set('view', next.view);
    if (next.commit) p.set('commit', next.commit);
    history.pushState(null, '', `?${p}`);
  };

  const onSubmit = (e) => {
    e.preventDefault();
    const newUrl = e.target.elements.repo.value;
    setPath('');
    setView('files');
    updateUrl({ repo: newUrl });
    loadRepo(newUrl);
  };

  const onEntryClick = (e, entryPath, type) => {
    e.preventDefault();
    setPath(entryPath);
    updateUrl({ repo: url, path: entryPath });
    if (repoReady) loadPath(entryPath);
  };

  const navToPath = (e, p) => {
    e.preventDefault();
    setPath(p);
    updateUrl({ repo: url, path: p });
    if (repoReady) {
      if (p) loadPath(p);
      else { setSubTree(null); setFileView(null); }
    }
  };

  const switchView = (e, newView) => {
    e.preventDefault();
    setPath('');
    setSubTree(null);
    setFileView(null);
    setView(newView);
    updateUrl({ repo: url, view: newView });
  };

  const onCommitClick = async (e, oid) => {
    e.preventDefault();
    setSelectedCommit(oid);
    updateUrl({ repo: url, view: 'commits', commit: oid });
    // Ensure history fetched so we can read parent commits
    if (!historyFetched && branch) {
      try {
        await git.fetch({ fs, http, dir, singleBranch: true, depth: HISTORY_DEPTH, ref: branch });
        setHistoryFetched(true);
      } catch (err) {
        setError(err.message || String(err));
        return;
      }
    }
    await loadCommitDetail(oid);
  };

  const exitCommitDetail = (e) => {
    e.preventDefault();
    setCommitDetail(null);
    setSelectedCommit('');
    updateUrl({ repo: url, view: 'commits' });
  };

  const onBranchChange = (e) => {
    const newBranch = e.target.value;
    if (newBranch === branch) return;
    // Page reload — fs uses wipe:true on construction so this gives clean state
    const p = new URLSearchParams({ repo: url });
    if (newBranch) p.set('branch', newBranch);
    location.search = p.toString();
  };

  useEffect(() => {
    const onPop = () => {
      const p = new URLSearchParams(location.search);
      const newPath = p.get('path') || '';
      const newView = p.get('view') || 'files';
      const newCommit = p.get('commit') || '';
      setPath(newPath);
      setView(newView);
      setSelectedCommit(newCommit);
      if (newPath) loadPath(newPath);
      else { setSubTree(null); setFileView(null); }
      if (newCommit) loadCommitDetail(newCommit);
      else setCommitDetail(null);
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [repoReady]);

  // After repo loads, if URL has &commit=, load that commit detail
  useEffect(() => {
    if (repoReady && initialCommit && !commitDetail) {
      onCommitClick({ preventDefault: () => {} }, initialCommit);
    }
  }, [repoReady]);

  const isCommitDetail = !!commitDetail;
  const isFileView = !!fileView && !isCommitDetail;
  const isFolderView = !!subTree && !fileView && !isCommitDetail;
  const isRootView = !fileView && !subTree && !isCommitDetail;
  const showFiles = !isFileView && !isCommitDetail && view === 'files';
  const showCommits = !isFileView && !isFolderView && !isCommitDetail && view === 'commits';
  const currentEntries = subTree || tree;
  const currentFolderPath = isFolderView ? path : '';

  const onCopyClone = () => {
    navigator.clipboard?.writeText(`git clone ${url}`);
  };

  return html`
    ${!repoReady && html`
      <h1>JSS Git</h1>
      <p class="meta">Browse a git repository hosted on a Solid pod (or any git remote).</p>
    `}
    ${repoReady && html`
      <p class="top-bar">
        <a href="?" class="brand">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <line x1="6" y1="7" x2="6" y2="17" stroke="#1f883d" stroke-width="2" stroke-linecap="round"/>
            <line x1="6" y1="12" x2="16" y2="12" stroke="#1f883d" stroke-width="2" stroke-linecap="round"/>
            <circle cx="6" cy="6" r="2.5" fill="#fff" stroke="#1f883d" stroke-width="2"/>
            <circle cx="6" cy="18" r="2.5" fill="#fff" stroke="#1f883d" stroke-width="2"/>
            <circle cx="18" cy="12" r="2.5" fill="#fff" stroke="#1f883d" stroke-width="2"/>
          </svg>
          <span class="brand-text">JSS Git</span>
        </a>
        <span class="brand-tagline">git on a Solid pod</span>
      </p>
    `}
    <form onSubmit=${onSubmit} class=${repoReady ? 'form-compact' : ''}>
      <div class="form-row">
        <input
          type="url"
          name="repo"
          placeholder="https://your.pod/path/repo"
          value=${url}
          onInput=${(e) => setUrl(e.target.value)}
        />
        <button type="submit">Load</button>
      </div>
    </form>

    ${error && html`<div class="error">${error}</div>`}
    ${loading && html`<p class="loading">Loading…</p>`}

    ${repoReady && (() => {
      const { owner, repo } = parseRepoUrl(url);
      const pathSegs = path ? path.split('/').filter(Boolean) : [];
      return html`
        <div class="repo-header">
          <span class="repo-breadcrumb">
            <span class="owner">${owner}</span>
            <span class="separator">/</span>
            ${pathSegs.length > 0
              ? html`<a class="repo-link" href="?repo=${encodeURIComponent(url)}" onClick=${(e) => navToPath(e, '')}>${repo}</a>`
              : html`<strong class="repo-name">${repo}</strong>`
            }
            ${pathSegs.map((seg, i) => {
              const segPath = pathSegs.slice(0, i + 1).join('/');
              const isLast = i === pathSegs.length - 1;
              return html`
                <span class="separator">/</span>
                ${isLast
                  ? html`<strong>${seg}</strong>`
                  : html`<a class="repo-link" href="?repo=${encodeURIComponent(url)}&path=${encodeURIComponent(segPath)}" onClick=${(e) => navToPath(e, segPath)}>${seg}</a>`
                }
              `;
            })}
            <span class="visibility-badge">\u{1F310} Public</span>
          </span>
          ${refs && (() => {
            const branchList = refs
              .filter(r => r.ref.startsWith('refs/heads/'))
              .map(r => r.ref.replace(/^refs\/heads\//, ''));
            if (branchList.length <= 1) return null;
            return html`
              <select class="branch-select" value=${branch} onChange=${onBranchChange}>
                ${branchList.map(b => html`<option value=${b}>${b}</option>`)}
              </select>
            `;
          })()}
          <span class="repo-actions">
            <button class="repo-action" title="Sign in to watch (Solid-native, not yet implemented)">
              \u{1F441} Watch <span class="count">0</span>
            </button>
            <button class="repo-action" title="Sign in to fork (Solid-native, not yet implemented)">
              \u{1F374} Fork <span class="count">0</span>
            </button>
            <button class="repo-action repo-action-star" title="Sign in to star (Solid-native, not yet implemented)">
              ⭐ Star <span class="count">0</span>
            </button>
          </span>
        </div>

        <div class="layout">
          <div class="main">
            ${!isFileView && !isFolderView && html`
              <div class="tabs">
                <a href="#" class=${view === 'files' ? 'tab active' : 'tab'} onClick=${(e) => switchView(e, 'files')}>Code</a>
                <a href="#" class=${view === 'commits' ? 'tab active' : 'tab'} onClick=${(e) => switchView(e, 'commits')}>Commits${commits ? ` (${commits.length})` : ''}</a>
              </div>
            `}

            ${isFileView && html`
              <p class="meta file-meta">
                <span class="oid">${fileView.oid?.slice(0, 8)}</span>
              </p>
              ${fileView.kind === 'markdown' && html`<div class="readme" dangerouslySetInnerHTML=${{ __html: fileView.html }}></div>`}
              ${fileView.kind === 'text' && (fileView.html
                ? html`<pre class="file-content language-${fileView.lang}"><code dangerouslySetInnerHTML=${{ __html: fileView.html }}></code></pre>`
                : html`<pre class="file-content"><code>${fileView.text}</code></pre>`)}
              ${fileView.kind === 'image' && html`<div class="file-content image"><img src=${fileView.src} alt=${fileView.path} /></div>`}
              ${fileView.kind === 'binary' && html`<p class="meta">Binary file (${fileView.size} bytes) — preview not shown.</p>`}
              ${fileView.kind === 'too-large' && html`<p class="meta">File too large to display (${fileView.size} bytes).</p>`}
            `}

            ${isRootView && view === 'files' && latestCommit && html`
              <div class="latest-commit">
                <span class="commit-author">${latestCommit.author}</span>
                <span class="commit-msg">${latestCommit.message}</span>
                <span class="oid">${latestCommit.oid.slice(0, 8)}</span>
                <span class="meta">${relativeTime(latestCommit.timestamp)}</span>
              </div>
            `}

            ${showFiles && currentEntries && currentEntries.length > 0 && html`
              <ul class="file-list">
                ${currentEntries.map((e) => {
                  const fullPath = currentFolderPath ? `${currentFolderPath}/${e.path}` : e.path;
                  return html`
                    <li>
                      <span class="file-icon">${fileIcon(e.path, e.type)}</span>
                      <a href="?repo=${encodeURIComponent(url)}&path=${encodeURIComponent(fullPath)}" onClick=${(ev) => onEntryClick(ev, fullPath, e.type)}>${e.path}</a>
                    </li>
                  `;
                })}
              </ul>
            `}

            ${isRootView && view === 'files' && readmeHtml && html`
              <h2>README</h2>
              <div class="readme" dangerouslySetInnerHTML=${{ __html: readmeHtml }}></div>
            `}

            ${showCommits && commitsLoading && html`<p class="loading">Loading commits…</p>`}
            ${showCommits && commits && commits.length > 0 && html`
              <ul class="commit-list">
                ${commits.map((c) => html`
                  <li class="commit commit-clickable" onClick=${(e) => onCommitClick(e, c.oid)}>
                    <div class="commit-message">${c.commit.message.split('\n')[0]}</div>
                    <div class="commit-meta">
                      <span class="commit-author">${c.commit.author.name}</span>
                      <span>committed ${relativeTime(c.commit.author.timestamp)}</span>
                      <a href="?repo=${encodeURIComponent(url)}&view=commits&commit=${c.oid}" class="oid" onClick=${(e) => onCommitClick(e, c.oid)}>${c.oid.slice(0, 8)}</a>
                    </div>
                  </li>
                `)}
              </ul>
            `}
            ${showCommits && commits && commits.length === 0 && html`<p class="meta">No commits.</p>`}

            ${isCommitDetail && commitDetail && html`
              <p class="meta breadcrumb">
                <a href="#" onClick=${exitCommitDetail}>← back to commits</a>
                <span class="separator">/</span>
                <span class="oid">${commitDetail.oid.slice(0, 8)}</span>
              </p>

              <div class="commit-detail">
                <pre class="commit-detail-message">${commitDetail.commit.message.trimEnd()}</pre>
                <div class="commit-detail-meta">
                  <span class="commit-author">${commitDetail.commit.author.name}</span>
                  <span class="meta">${commitDetail.commit.author.email}</span>
                  <span class="meta">committed ${relativeTime(commitDetail.commit.author.timestamp)}</span>
                </div>
                ${commitDetail.parents.length > 0 && html`
                  <div class="commit-detail-meta">
                    <span class="meta">Parent${commitDetail.parents.length > 1 ? 's' : ''}:</span>
                    ${commitDetail.parents.map(p => html`<a href="?repo=${encodeURIComponent(url)}&view=commits&commit=${p}" class="oid" onClick=${(e) => onCommitClick(e, p)}>${p.slice(0, 8)}</a>`)}
                  </div>
                `}
              </div>

              <h3 style="margin-top: 1.5rem;">Changed files (${commitDetail.files.length})</h3>
              ${commitDetail.files.length === 0
                ? html`<p class="meta">No file changes detected.</p>`
                : html`
                  <ul class="file-list">
                    ${commitDetail.files.map(f => html`
                      <li>
                        <span class="file-icon">${fileIcon(f.path.split('/').pop(), 'blob')}</span>
                        <span class=${'change-badge change-' + f.change}>${f.change}</span>
                        <span class="path-segment">${f.path}</span>
                      </li>
                    `)}
                  </ul>
                `
              }
            `}
          </div>

          <aside class="sidebar">
            <h3>About</h3>
            <p class="sidebar-desc">A repository hosted on a Solid pod.</p>
            <p class="sidebar-link"><a href=${url} target="_blank" rel="noopener">${url}</a></p>
            <ul class="sidebar-stats">
              ${branch && html`<li><span class="stat-label">Branch</span><code>${branch}</code></li>`}
              ${refs && html`<li><span class="stat-label">Refs</span>${refs.length}</li>`}
              ${commits && html`<li><span class="stat-label">Commits</span>${commits.length}+</li>`}
              ${tree && html`<li><span class="stat-label">Files (root)</span>${tree.length}</li>`}
              ${refs && (() => {
                const tags = refs.filter(r => r.ref.startsWith('refs/tags/')).map(r => r.ref.replace(/^refs\/tags\//, ''));
                if (tags.length === 0) return null;
                return html`<li><span class="stat-label">Tags</span>${tags.length}</li>`;
              })()}
            </ul>
            ${refs && (() => {
              const tags = refs.filter(r => r.ref.startsWith('refs/tags/')).map(r => r.ref.replace(/^refs\/tags\//, ''));
              if (tags.length === 0) return null;
              return html`
                <h3 style="margin-top: 1.5rem;">Tags</h3>
                <ul class="tag-list">
                  ${tags.slice(0, 10).map(t => html`<li><code>${t}</code></li>`)}
                  ${tags.length > 10 && html`<li class="meta">+${tags.length - 10} more</li>`}
                </ul>
              `;
            })()}
            <h3 style="margin-top: 1.5rem;">Clone</h3>
            <div class="clone-box">
              <input type="text" readonly class="clone-url" value=${url} onClick=${(e) => e.target.select()} />
              <button class="copy-btn" onClick=${onCopyClone} title="Copy URL">\u{1F4CB}</button>
            </div>
          </aside>
        </div>
      `;
    })()}

    ${refs && refs.length === 0 && html`<p class="meta">No refs found (empty repo).</p>`}

    <p class="meta footer">
      Powered by <a href="https://jss.live">jss.live</a>
      · <a href="https://github.com/JavaScriptSolidServer/git">View source</a>
    </p>
  `;
}

render(html`<${App}/>`, document.getElementById('app'));
