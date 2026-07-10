// Single-page PDF portfolio viewer built on Mozilla's PDF.js.
// Renders one page at a time to a canvas, fitted to the stage, with
// arrow / keyboard / swipe navigation.
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.worker.min.mjs';

const PDF_URL = 'portfolio.pdf';

const viewer = document.querySelector('.viewer');
const stage = document.getElementById('viewer-stage');
let canvas = document.getElementById('pdf-canvas');
const status = document.getElementById('viewer-status');
const counter = document.getElementById('page-counter');
const prevBtn = document.getElementById('prev-page');
const nextBtn = document.getElementById('next-page');
const fsBtn = document.getElementById('fullscreen-btn');
const pwForm = document.getElementById('password-form');
const pwInput = document.getElementById('password-input');
const pwError = document.getElementById('password-error');

let pdfDoc = null;
let currentPage = 1;
let rendering = false;

// Rendered pages are cached (keyed by page number + stage size) and adjacent
// pages are pre-rendered, so flipping swaps a ready canvas in instantly.
const pageCache = new Map(); // pageNum -> { key, canvas }

function fitKey() {
    return `${stage.clientWidth}x${stage.clientHeight}@${window.devicePixelRatio || 1}`;
}

function cachedCanvas(num) {
    const entry = pageCache.get(num);
    return entry && entry.key === fitKey() ? entry.canvas : null;
}

async function renderToCanvas(num) {
    const page = await pdfDoc.getPage(num);

    // Fit the page inside the stage, then upscale the canvas buffer by
    // devicePixelRatio so it stays crisp on retina displays.
    const base = page.getViewport({ scale: 1 });
    const fit = Math.min(stage.clientWidth / base.width, stage.clientHeight / base.height);
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: fit * dpr });

    const c = document.createElement('canvas');
    c.width = viewport.width;
    c.height = viewport.height;
    c.style.width = `${viewport.width / dpr}px`;
    c.style.height = `${viewport.height / dpr}px`;

    await page.render({ canvasContext: c.getContext('2d'), viewport }).promise;
    return c;
}

function show(cnv) {
    if (cnv === canvas) return;
    cnv.id = canvas.id;
    canvas.replaceWith(cnv);
    canvas = cnv;
    status.hidden = true;
}

function updateControls() {
    counter.textContent = `${currentPage} / ${pdfDoc.numPages}`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= pdfDoc.numPages;
}

function evict() {
    for (const [num, entry] of pageCache) {
        if (entry.key !== fitKey()) pageCache.delete(num);
    }
    while (pageCache.size > 8) {
        let worst = null;
        let dist = -1;
        for (const num of pageCache.keys()) {
            const d = Math.abs(num - currentPage);
            if (d > dist) { dist = d; worst = num; }
        }
        pageCache.delete(worst);
    }
}

// The current page renders first, then its neighbours are pre-rendered.
function nextJob() {
    for (const num of [currentPage, currentPage + 1, currentPage - 1]) {
        if (num >= 1 && num <= pdfDoc.numPages && !cachedCanvas(num)) return num;
    }
    return null;
}

// Single render loop: PDF.js renders one page at a time, and re-checking
// nextJob() each pass makes it converge on the latest requested page.
async function pump() {
    if (rendering || !pdfDoc) return;
    rendering = true;
    try {
        let num;
        while ((num = nextJob()) !== null) {
            const key = fitKey();
            const cnv = await renderToCanvas(num);
            if (key !== fitKey()) continue; // stage resized mid-render; redo
            pageCache.set(num, { key, canvas: cnv });
            if (num === currentPage) show(cnv);
            evict();
        }
    } catch (err) {
        console.error(err);
    } finally {
        rendering = false;
    }
}

function goTo(num) {
    if (!pdfDoc) return;
    const target = Math.min(Math.max(num, 1), pdfDoc.numPages);
    if (target === currentPage) return;
    currentPage = target;
    updateControls();
    const ready = cachedCanvas(target);
    if (ready) show(ready);
    pump();
}

prevBtn.addEventListener('click', () => goTo(currentPage - 1));
nextBtn.addEventListener('click', () => goTo(currentPage + 1));

document.addEventListener('keydown', (e) => {
    if (!pwForm.hidden && e.target === pwInput) return;
    if (e.key === 'ArrowLeft') goTo(currentPage - 1);
    if (e.key === 'ArrowRight') goTo(currentPage + 1);
});

const fsSupported = document.fullscreenEnabled || document.webkitFullscreenEnabled;

fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
        (viewer.requestFullscreen || viewer.webkitRequestFullscreen).call(viewer);
    }
});

for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(ev, () => {
        const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        fsBtn.textContent = fs ? 'exit fullscreen' : 'fullscreen';
    });
}

let touchStartX = null;
stage.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].clientX;
}, { passive: true });
stage.addEventListener('touchend', (e) => {
    if (touchStartX === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (dx > 50) goTo(currentPage - 1);
    if (dx < -50) goTo(currentPage + 1);
}, { passive: true });

// Re-fit whenever the stage changes size (window resize, rotation, and
// fullscreen transitions — observing the stage waits out the transition).
let resizeTimer;
new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(pump, 150);
}).observe(stage);

// The PDF is AES-encrypted; visitors unlock it with a shared password and
// PDF.js decrypts it in the browser.
let pdfBytes = null;

// getDocument transfers the buffer to its worker (detaching it), so each
// attempt gets its own copy.
function tryOpen(password) {
    return pdfjsLib.getDocument({ data: pdfBytes.slice(0), password }).promise;
}

function start(doc) {
    pdfDoc = doc;
    pwForm.hidden = true;
    pwInput.blur();
    status.textContent = 'Loading…';
    if (fsSupported) fsBtn.hidden = false;
    updateControls();
    pump();
}

pwForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!pwInput.value) return;
    pwError.hidden = true;
    tryOpen(pwInput.value).then(start, (err) => {
        if (err.name === 'PasswordException') {
            pwError.hidden = false;
            pwInput.select();
        } else {
            console.error(err);
            pwForm.hidden = true;
            status.hidden = false;
            status.textContent = 'Something went wrong loading the portfolio.';
        }
    });
});

// Download the whole file up front and hand PDF.js the bytes — letting
// PDF.js stream the document itself can stall renders mid-download.
fetch(PDF_URL)
    .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${PDF_URL}`);
        return res.arrayBuffer();
    })
    .then((data) => {
        pdfBytes = data;
        return tryOpen(undefined).then(start, (err) => {
            if (err.name !== 'PasswordException') throw err;
            status.hidden = true;
            pwForm.hidden = false;
            pwInput.focus();
        });
    })
    .catch((err) => {
        console.error(err);
        pwForm.hidden = true;
        status.hidden = false;
        status.textContent = 'Portfolio coming soon — check back shortly.';
    });
