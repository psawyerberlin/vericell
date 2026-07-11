/**
 * VeriCell — proof of authorship, integrity and time on Nervos CKB.
 *
 * All hashing happens locally (Web Crypto, SHA-256). Only the manifest
 * (title, paths, hashes, source URL) is written into the data field of a
 * live CKB cell locked to the user's wallet.
 *
 * Wallet + chain access via CCC: https://github.com/ckb-devrel/ccc
 */
import { ccc } from "@ckb-ccc/ccc";

/* ================================================================== */
/* State                                                              */
/* ================================================================== */
const state = {
  network: "testnet",
  client: new ccc.ClientPublicTestnet(),
  signer: null,
  address: null,
  entries: [], // [{ p: path, h: sha256hex, bytes }]
};

const MANIFEST_APP = "vericell";
const MANIFEST_VERSION = 1;
const EXPLORER = {
  testnet: "https://testnet.explorer.nervos.org",
  mainnet: "https://explorer.nervos.org",
};

/* ================================================================== */
/* Hashing helpers                                                    */
/* ================================================================== */
async function sha256Hex(data /* ArrayBuffer|Uint8Array */) {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256HexOfText(text) {
  return sha256Hex(new TextEncoder().encode(text));
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** Overall project hash: SHA-256 over the sorted "path\nhash\n" lines.
 *  Deterministic — anyone can reproduce it from the file list. */
async function projectHash(entries) {
  const canon = [...entries]
    .sort((a, b) => a.p.localeCompare(b.p))
    .map((e) => `${e.p}\n${e.h}\n`)
    .join("");
  return sha256HexOfText(canon);
}

/** Merkle root over sorted leaf hashes (SHA-256 of concatenated pairs). */
async function merkleRoot(entries) {
  let level = [...entries].sort((a, b) => a.p.localeCompare(b.p)).map((e) => hexToBytes(e.h));
  if (level.length === 0) return null;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? level[i]; // duplicate last on odd count
      const cat = new Uint8Array(left.length + right.length);
      cat.set(left, 0);
      cat.set(right, left.length);
      next.push(new Uint8Array(await crypto.subtle.digest("SHA-256", cat)));
    }
    level = next;
  }
  return [...level[0]].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ================================================================== */
/* Local registry (browser index of created proofs).                  */
/* Production: replace with an indexer service — see TECHNICAL.md.    */
/* ================================================================== */
function regKey() {
  return `vericell:${state.network}`;
}
function loadRegistry() {
  try {
    return JSON.parse(localStorage.getItem(regKey()) || "[]");
  } catch {
    return [];
  }
}
function saveRegistry(list) {
  localStorage.setItem(regKey(), JSON.stringify(list));
}
function addToRegistry(rec) {
  const list = loadRegistry();
  list.unshift(rec);
  saveRegistry(list);
}

/* ================================================================== */
/* Wallet (JoyID via CCC — other CCC signers plug in the same way)    */
/* ================================================================== */
async function connectWallet() {
  const btn = document.getElementById("connectBtn");
  try {
    btn.textContent = "Connecting…";
    state.signer = new ccc.JoyId.CkbSigner(state.client, "VeriCell", location.origin + "/icon.svg");
    await state.signer.connect();
    state.address = await state.signer.getRecommendedAddress();
    btn.textContent = `${state.address.slice(0, 8)}…${state.address.slice(-6)}`;
    btn.classList.add("is-connected");
    btn.title = state.address;
    document.getElementById("createPanel").classList.remove("is-locked");
    document.getElementById("createGate").textContent = "Wallet connected — you can anchor proofs.";
  } catch (e) {
    btn.textContent = "Connect wallet";
    setStatus("submitStatus", `Wallet connection failed: ${e.message || e}`, true);
  }
}

function switchNetwork(net) {
  state.network = net;
  state.client = net === "mainnet" ? new ccc.ClientPublicMainnet() : new ccc.ClientPublicTestnet();
  // force re-connect on the new network
  state.signer = null;
  state.address = null;
  const btn = document.getElementById("connectBtn");
  btn.textContent = "Connect wallet";
  btn.classList.remove("is-connected");
  document.getElementById("createPanel").classList.add("is-locked");
}

/* ================================================================== */
/* Manifest & on-chain anchoring                                      */
/* ================================================================== */
function buildManifest({ compact, title, url, projHash, root, prev, genesis }) {
  const m = {
    app: MANIFEST_APP,
    v: MANIFEST_VERSION,
    title,
    created: new Date().toISOString(),
    project_sha256: projHash,
    merkle_root: root,
    count: state.entries.length,
  };
  if (url) m.source = url;
  if (prev) m.prev = prev; // tx hash of previous version's cell
  if (genesis) m.genesis = genesis; // tx hash of the very first version (project UNID)
  if (!compact) m.files = state.entries.map((e) => ({ p: e.p, h: e.h }));
  return m;
}

function manifestBytes(manifest) {
  return ccc.bytesFrom(JSON.stringify(manifest), "utf8");
}

/** Create the proof cell. Optionally consumes the previous version's cell. */
async function anchorProof({ compact, prevOutPoint }) {
  if (!state.signer) throw new Error("Connect a wallet first.");
  if (state.entries.length === 0) throw new Error("Add at least one file or hash.");

  const title = document.getElementById("projTitle").value.trim() || "Untitled project";
  const url = document.getElementById("projUrl").value.trim();
  const projHash = await projectHash(state.entries);
  const root = await merkleRoot(state.entries);

  const manifest = buildManifest({ compact, title, url, projHash, root });
  const data = manifestBytes(manifest);

  const { script: lock } = await state.signer.getRecommendedAddressObj();

  const tx = ccc.Transaction.from({
    inputs: prevOutPoint ? [{ previousOutput: prevOutPoint }] : [],
    outputs: [{ lock }], // capacity auto-set to the minimum for the data
    outputsData: [data],
  });
  await tx.completeInputsByCapacity(state.signer);
  await tx.completeFeeBy(state.signer, 1000);
  const txHash = await state.signer.sendTransaction(tx);

  addToRegistry({
    unid: txHash, // v1: creation tx hash. Production: type ID (TECHNICAL.md)
    txHash,
    index: 0,
    title,
    source: url || null,
    created: manifest.created,
    active: true,
    address: state.address,
    project_sha256: projHash,
    merkle_root: root,
    hashes: state.entries.map((e) => e.h), // backward search: every file hash
    files: manifest.files || null,
    count: state.entries.length,
    network: state.network,
  });
  return { txHash, manifest };
}

/* ================================================================== */
/* Search & on-chain verification                                     */
/* ================================================================== */
function searchRegistry(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  return loadRegistry().filter(
    (r) =>
      r.title.toLowerCase().includes(q) ||
      r.txHash.toLowerCase().includes(q.replace(/^0x/, "")) ||
      (r.address && r.address.toLowerCase() === q) ||
      r.project_sha256 === q ||
      (r.merkle_root && r.merkle_root === q) ||
      r.hashes.includes(q),
  );
}

/** Fetch a proof cell from chain: live status, data, block time. */
async function fetchProofFromChain(txHash, index = 0) {
  const out = { live: null, manifest: null, blockTime: null, lockOwner: null };
  try {
    const res = await state.client.getTransaction(txHash);
    if (!res) return out;
    const txOut = res.transaction?.outputs?.[index];
    const rawData = res.transaction?.outputsData?.[index];
    if (rawData) {
      try {
        out.manifest = JSON.parse(new TextDecoder().decode(ccc.bytesFrom(rawData)));
      } catch {
        /* not a VeriCell manifest */
      }
    }
    if (txOut?.lock) {
      out.lockOwner = ccc.Address.fromScript(txOut.lock, state.client).toString();
    }
    if (res.blockHash) {
      try {
        const header = await state.client.getHeaderByHash(res.blockHash);
        if (header?.timestamp) out.blockTime = new Date(Number(header.timestamp));
      } catch {
        /* header lookup optional */
      }
    }
    try {
      const cell = await state.client.getCellLive({ txHash, index: ccc.numFrom(index) }, false);
      out.live = !!cell;
    } catch {
      out.live = false;
    }
  } catch (e) {
    console.warn("chain lookup failed", e);
  }
  return out;
}

/* ================================================================== */
/* Input sources                                                      */
/* ================================================================== */
async function addFiles(fileList) {
  const files = [...fileList];
  setStatus("submitStatus", `Hashing ${files.length} file(s)…`);
  for (const f of files) {
    const path = f.webkitRelativePath || f.name;
    const h = await sha256Hex(await f.arrayBuffer());
    upsertEntry({ p: path, h, bytes: f.size });
  }
  setStatus("submitStatus", "");
  renderManifest();
}

async function addGithubRepo(spec) {
  let [repo, branch] = spec
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .split("@");
  repo = repo.replace(/\/$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error("Use the form owner/repo or owner/repo@branch");
  if (!branch) {
    const meta = await (await fetch(`https://api.github.com/repos/${repo}`)).json();
    branch = meta.default_branch || "main";
  }
  const tree = await (
    await fetch(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`)
  ).json();
  if (!tree.tree) throw new Error(tree.message || "Could not read the repository tree.");
  const blobs = tree.tree.filter((t) => t.type === "blob").slice(0, 200);
  let done = 0;
  for (const b of blobs) {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${b.path}`);
    if (!res.ok) continue;
    const h = await sha256Hex(await res.arrayBuffer());
    upsertEntry({ p: b.path, h, bytes: b.size ?? 0 });
    setStatus("submitStatus", `Hashing ${repo}@${branch}: ${++done}/${blobs.length}`);
  }
  setStatus("submitStatus", "");
  renderManifest();
}

async function addUrl(url) {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(
      `Fetch failed (${res.status}). The server may block CORS — download the file and use "Local files".`,
    );
  const buf = await res.arrayBuffer();
  const h = await sha256Hex(buf);
  upsertEntry({ p: url, h, bytes: buf.byteLength });
  renderManifest();
}

function addPastedHashes(text) {
  for (const line of text.split("\n")) {
    const m =
      line.trim().match(/^(.*?)[\s,;]+([a-fA-F0-9]{64})$/) ||
      line.trim().match(/^([a-fA-F0-9]{64})$/);
    if (!m) continue;
    const h = (m[2] || m[1]).toLowerCase();
    const p = m[2] ? m[1].trim() : `hash-${h.slice(0, 8)}`;
    upsertEntry({ p, h, bytes: 0 });
  }
  renderManifest();
}

function upsertEntry(entry) {
  const i = state.entries.findIndex((e) => e.p === entry.p);
  if (i >= 0) state.entries[i] = entry;
  else state.entries.push(entry);
}

/* ================================================================== */
/* UI rendering                                                       */
/* ================================================================== */
function setStatus(id, msg, err = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("err", err);
}

/** Signature element: SHA-256 rendered as 16 colored bars. */
function fpStrip(hex, el) {
  el.innerHTML = "";
  for (let i = 0; i < 32; i += 2) {
    const span = document.createElement("span");
    const hue = parseInt(hex.substr(i * 2, 3), 16) % 360;
    const light = 35 + (parseInt(hex.substr(i * 2 + 3, 1), 16) % 30);
    span.style.background = `hsl(${hue} 55% ${light}%)`;
    el.appendChild(span);
  }
}

async function renderManifest() {
  const box = document.getElementById("manifestBox");
  const list = document.getElementById("fileList");
  box.hidden = state.entries.length === 0;
  document.getElementById("fileCount").textContent = state.entries.length;
  list.innerHTML = "";
  for (const e of state.entries) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="fpath"></span><span class="fhash"></span><button class="rm" title="Remove">✕</button>`;
    li.querySelector(".fpath").textContent = e.p;
    li.querySelector(".fhash").textContent = e.h.slice(0, 16) + "…";
    li.querySelector(".rm").onclick = () => {
      state.entries = state.entries.filter((x) => x !== e);
      renderManifest();
    };
    list.appendChild(li);
  }
  if (state.entries.length) {
    const ph = await projectHash(state.entries);
    document.getElementById("projHash").textContent = ph;
    fpStrip(ph, document.getElementById("projFp"));
    // cost estimate: cell = data bytes + 61 bytes overhead, 1 CKB per byte
    const full = manifestBytes(
      buildManifest({
        compact: false,
        title: document.getElementById("projTitle").value || "Untitled project",
        url: document.getElementById("projUrl").value,
        projHash: ph,
        root: ph,
      }),
    ).length;
    const compact = manifestBytes(
      buildManifest({
        compact: true,
        title: document.getElementById("projTitle").value || "Untitled project",
        url: document.getElementById("projUrl").value,
        projHash: ph,
        root: ph,
      }),
    ).length;
    document.getElementById("fullCost").textContent = `≈ ${full + 65} CKB locked (refundable)`;
    document.getElementById("rootCost").textContent = `≈ ${compact + 65} CKB locked (refundable)`;
  }
}

function renderResults(records, matchedHash = null) {
  const box = document.getElementById("searchResults");
  box.innerHTML = "";
  if (!records.length) {
    box.innerHTML = `<p class="gate-note">No local matches. Paste a transaction hash to look a proof up directly on-chain.</p>`;
    return;
  }
  for (const r of records) {
    const a = document.createElement("a");
    a.className = "result-card";
    a.href = `#detail`;
    a.innerHTML = `
      <span class="rc-title"></span>
      ${r.active ? '<span class="badge live">checking…</span>' : '<span class="badge dead">superseded</span>'}
      ${matchedHash ? '<span class="badge match">hash match</span>' : ""}
      <div class="fp-strip small"></div>
      <div class="rc-meta"></div>`;
    a.querySelector(".rc-title").textContent = r.title;
    a.querySelector(".rc-meta").textContent =
      `${r.count} entries · ${new Date(r.created).toLocaleString()} · tx ${r.txHash.slice(0, 14)}…`;
    fpStrip(r.project_sha256, a.querySelector(".fp-strip"));
    a.onclick = () => showDetail(r);
    box.appendChild(a);
    // refresh live status from chain
    fetchProofFromChain(r.txHash, r.index).then(({ live }) => {
      const b = a.querySelector(".badge.live");
      if (!b) return;
      if (live === true) b.textContent = "LIVE";
      else if (live === false) {
        b.textContent = "consumed";
        b.className = "badge dead";
      } else b.textContent = "unknown";
    });
  }
}

async function showDetail(rec) {
  const sec = document.getElementById("detail");
  const panel = document.getElementById("detailPanel");
  sec.hidden = false;
  panel.innerHTML = `<p class="gate-note">Loading on-chain proof…</p>`;
  sec.scrollIntoView({ behavior: "smooth" });

  const chain = await fetchProofFromChain(rec.txHash, rec.index);
  const m = chain.manifest || rec;
  const files = m.files || rec.files || [];
  const explorer = `${EXPLORER[state.network]}/transaction/${rec.txHash}`;

  panel.innerHTML = `
    <h3></h3>
    <div class="fp-strip"></div>
    <dl class="kv">
      <dt>Status</dt><dd>${
        chain.live === true
          ? '<span class="badge live">LIVE — current version</span>'
          : chain.live === false
            ? '<span class="badge dead">consumed — superseded or withdrawn</span>'
            : "unknown"
      }</dd>
      <dt>Project ID (UNID)</dt><dd>${rec.unid}</dd>
      <dt>Overall SHA-256</dt><dd>${m.project_sha256 || rec.project_sha256}</dd>
      <dt>Merkle root</dt><dd>${m.merkle_root || rec.merkle_root || "—"}</dd>
      <dt>Created (manifest)</dt><dd>${m.created || rec.created}</dd>
      <dt>Block timestamp</dt><dd>${chain.blockTime ? chain.blockTime.toISOString() + " (authoritative)" : "pending / unavailable"}</dd>
      <dt>Owner (lock)</dt><dd>${chain.lockOwner || rec.address || "—"}</dd>
      <dt>Source URL</dt><dd>${m.source ? `<a href="${m.source}" target="_blank" rel="noopener">${m.source}</a>` : "—"}</dd>
      <dt>Transaction</dt><dd><a href="${explorer}" target="_blank" rel="noopener">${rec.txHash}</a></dd>
    </dl>
    ${
      files.length
        ? `<p><strong>${files.length}</strong> fingerprinted entries:</p>
      <ul class="file-list">${files
        .map(
          (f) =>
            `<li><span class="fpath">${escapeHtml(f.p)}</span><span class="fhash">${f.h}</span><span></span></li>`,
        )
        .join("")}</ul>`
        : `<p class="gate-note">Compact proof — individual file hashes are represented by the Merkle root.</p>`
    }
    <div class="submit-row">
      <button class="btn btn-ghost btn-small" id="newVersionBtn">Publish new version (consume this cell)</button>
    </div>`;
  panel.querySelector("h3").textContent = m.title || rec.title;
  fpStrip(m.project_sha256 || rec.project_sha256, panel.querySelector(".fp-strip"));

  panel.querySelector("#newVersionBtn").onclick = () => {
    if (!state.signer) {
      alert("Connect your wallet first.");
      return;
    }
    state.pendingPrev = {
      outPoint: { txHash: rec.txHash, index: ccc.numFrom(rec.index) },
      genesis: rec.unid,
      rec,
    };
    document.getElementById("projTitle").value = rec.title;
    if (rec.source) document.getElementById("projUrl").value = rec.source;
    document.getElementById("create").scrollIntoView({ behavior: "smooth" });
    setStatus(
      "submitStatus",
      "New-version mode: the previous cell will be consumed when you anchor. Add the new files.",
    );
  };
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/* ================================================================== */
/* Verify a dropped file                                              */
/* ================================================================== */
async function verifyFile(file) {
  const h = await sha256Hex(await file.arrayBuffer());
  document.getElementById("searchInput").value = h;
  const hits = searchRegistry(h);
  renderResults(hits, h);
  document.getElementById("verify").scrollIntoView({ behavior: "smooth" });
}

/* ================================================================== */
/* Wire up the UI                                                     */
/* ================================================================== */
function wireDropzone(el, onFiles) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("is-over");
  });
  el.addEventListener("dragleave", () => el.classList.remove("is-over"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("is-over");
    if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
  });
  el.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = () => input.files.length && onFiles(input.files);
    input.click();
  });
}

function init() {
  document.getElementById("connectBtn").onclick = connectWallet;
  document.getElementById("networkSelect").onchange = (e) => switchNetwork(e.target.value);

  // hero demo
  wireDropzone(document.getElementById("heroDrop"), async (files) => {
    const h = await sha256Hex(await files[0].arrayBuffer());
    const out = document.getElementById("heroHashOut");
    out.hidden = false;
    out.querySelector("[data-hash]").textContent = h;
    fpStrip(h, out.querySelector("[data-fp]"));
    document.getElementById("heroSearchBtn").onclick = () => {
      document.getElementById("searchInput").value = h;
      renderResults(searchRegistry(h), h);
      document.getElementById("verify").scrollIntoView({ behavior: "smooth" });
    };
  });

  // source tabs
  document.querySelectorAll(".src-tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".src-tab").forEach((t) => t.classList.remove("is-active"));
      document.querySelectorAll(".src-pane").forEach((p) => p.classList.remove("is-active"));
      tab.classList.add("is-active");
      document.querySelector(`[data-pane="${tab.dataset.src}"]`).classList.add("is-active");
    };
  });
  document.querySelectorAll("[data-open]").forEach((btn) => {
    btn.onclick = () => document.getElementById(btn.dataset.open).click();
  });
  document.getElementById("filesInput").onchange = (e) => addFiles(e.target.files);
  document.getElementById("folderInput").onchange = (e) => addFiles(e.target.files);
  document.getElementById("ghFetchBtn").onclick = () =>
    addGithubRepo(document.getElementById("ghRepo").value).catch((e) =>
      setStatus("submitStatus", e.message, true),
    );
  document.getElementById("urlFetchBtn").onclick = () =>
    addUrl(document.getElementById("urlInput").value).catch((e) =>
      setStatus("submitStatus", e.message, true),
    );
  document.getElementById("hashAddBtn").onclick = () =>
    addPastedHashes(document.getElementById("hashPaste").value);
  document.getElementById("clearBtn").onclick = () => {
    state.entries = [];
    state.pendingPrev = null;
    renderManifest();
    setStatus("submitStatus", "");
  };

  // anchor
  document.getElementById("submitBtn").onclick = async () => {
    const btn = document.getElementById("submitBtn");
    btn.disabled = true;
    try {
      const compact = document.querySelector('input[name="storemode"]:checked').value === "root";
      setStatus("submitStatus", "Building transaction — confirm in your wallet…");
      const prev = state.pendingPrev;
      const { txHash } = await anchorProof({
        compact,
        prevOutPoint: prev?.outPoint || null,
      });
      if (prev) {
        // mark the superseded record inactive and link versions in the registry
        const list = loadRegistry();
        const old = list.find((r) => r.txHash === prev.rec.txHash);
        if (old) old.active = false;
        const neu = list.find((r) => r.txHash === txHash);
        if (neu) {
          neu.unid = prev.genesis;
          neu.prev = prev.rec.txHash;
        }
        saveRegistry(list);
        state.pendingPrev = null;
      }
      setStatus("submitStatus", `Anchored ✔ tx ${txHash.slice(0, 18)}… — view it in Search below.`);
      state.entries = [];
      renderManifest();
    } catch (e) {
      setStatus("submitStatus", e.message || String(e), true);
    } finally {
      btn.disabled = false;
    }
  };

  // search & verify
  document.getElementById("searchBtn").onclick = async () => {
    const q = document.getElementById("searchInput").value.trim();
    let hits = searchRegistry(q);
    // direct on-chain lookup by tx hash
    if (!hits.length && /^(0x)?[a-fA-F0-9]{64}$/.test(q)) {
      const txHash = q.startsWith("0x") ? q : "0x" + q;
      const chain = await fetchProofFromChain(txHash, 0);
      if (chain.manifest?.app === MANIFEST_APP) {
        hits = [
          {
            unid: chain.manifest.genesis || txHash,
            txHash,
            index: 0,
            title: chain.manifest.title,
            source: chain.manifest.source || null,
            created: chain.manifest.created,
            active: chain.live !== false,
            address: chain.lockOwner,
            project_sha256: chain.manifest.project_sha256,
            merkle_root: chain.manifest.merkle_root || null,
            hashes: (chain.manifest.files || []).map((f) => f.h),
            files: chain.manifest.files || null,
            count: chain.manifest.count ?? (chain.manifest.files || []).length,
          },
        ];
      }
    }
    renderResults(hits);
  };
  document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("searchBtn").click();
  });
  wireDropzone(document.getElementById("verifyDrop"), (files) => verifyFile(files[0]));

  document.getElementById("projTitle").addEventListener("input", () => renderManifest());
}

init();
