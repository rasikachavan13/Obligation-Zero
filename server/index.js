import express from 'express';
import cors from 'cors';
import multer from 'multer';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = Number(process.env.PORT || 8787);
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:4b';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 10 } });
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

const normalize = (s = '') => s.toLowerCase().replace(/\s+/g, ' ').replace(/[“”]/g, '"').trim();
const cleanText = (s = '') => s.replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

async function extractFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  let text = '';
  let pageTexts = [];
  if (ext === '.pdf' || file.mimetype === 'application/pdf') {
    const result = await pdf(file.buffer);
    text = result.text || '';
    pageTexts = text.split('\f').map((t) => cleanText(t)).filter(Boolean);
    if (!pageTexts.length && text.trim()) pageTexts = [cleanText(text)];
  } else if (ext === '.docx' || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    text = result.value || '';
    pageTexts = [cleanText(text)];
  } else if (['.txt', '.md', '.csv', '.eml'].includes(ext) || file.mimetype.startsWith('text/')) {
    text = file.buffer.toString('utf8');
    pageTexts = [cleanText(text)];
  } else {
    throw new Error(`Unsupported file type for ${file.originalname}. Upload PDF, DOCX, TXT, MD, CSV, or EML.`);
  }
  text = cleanText(text);
  if (!text) throw new Error(`${file.originalname} has no extractable text. Scanned PDFs need OCR, which this version does not include.`);
  return { name: file.originalname, size: file.size, type: ext.replace('.', '').toUpperCase(), text: text.slice(0, 60000), pageTexts };
}

function sentences(text) {
  return text.replace(/\r/g, '').split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 18);
}
function localFallback(doc) {
  const candidates = sentences(doc.text).filter(s => /\b(due|deadline|by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d)|submit|must|required|please reply|respond|registration|payment|renew|bring|complete|send|upload|attend|appointment)\b/i.test(s)).slice(0, 8);
  return candidates.map((quote, i) => ({ title: quote.length > 72 ? `${quote.slice(0, 69).trim()}…` : quote, description: 'Potential action detected from the source text. Review before acting.', deadline: null, priority: /deadline|due|must|required|by\s+\w+/i.test(quote) ? 'Needs review' : 'Can wait', category: /reply|respond|email/i.test(quote) ? 'Reply' : 'Task', evidence: quote, page: findPage(doc, quote), draft: '' , id: `${Date.now()}-${i}` }));
}
function findPage(doc, quote) {
  const target = normalize(quote);
  const index = doc.pageTexts.findIndex(p => normalize(p).includes(target.slice(0, Math.min(60, target.length))));
  return index >= 0 && doc.type === 'PDF' ? index + 1 : null;
}
function parseModelJson(raw) {
  const trimmed = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The local model did not return valid JSON. Try again or use the fallback extraction.');
  return JSON.parse(trimmed.slice(start, end + 1));
}
async function analyzeWithOllama(doc) {
  const prompt = `You are Obligation Zero, a careful document-to-action assistant. Extract only actions that are explicitly supported by the document. Never invent a date, deadline, person, obligation, or quoted sentence. If a date is ambiguous, set deadline to null. Return JSON only with shape: {"summary":"one short sentence","actions":[{"title":"short imperative title","description":"short explanation","deadline":"exact date/time stated or null","priority":"Urgent|Normal|Can wait|Needs review","category":"Task|Reply|Read|Payment|Appointment","evidence":"an exact verbatim sentence copied from document","draft":"optional short reply draft or empty string"}]}. Evidence must be an exact sentence from the source. Return at most 8 actions. Do not include generic advice. If no actions, return an empty actions array.\n\nDOCUMENT: ${doc.name}\nTEXT:\n${doc.text.slice(0, 24000)}`;
  const response = await fetch(`${OLLAMA_URL}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, format: 'json', messages: [{ role: 'system', content: 'Respond with valid JSON only.' }, { role: 'user', content: prompt }], options: { temperature: 0.1 } }) });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Ollama returned ${response.status}. Is Ollama running and model ${OLLAMA_MODEL} installed? ${detail.slice(0, 160)}`);
  }
  const payload = await response.json();
  const parsed = parseModelJson(payload.message?.content || '');
  const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const actions = rawActions.map((a, i) => {
    const evidence = String(a.evidence || '').trim();
    // Reject unsupported model quotations; choose a real sentence from source instead.
    const verified = evidence && normalize(doc.text).includes(normalize(evidence));
    const safeEvidence = verified ? evidence : sentences(doc.text).find(s => /\b(due|deadline|submit|must|required|reply|respond|complete|send|upload|attend|payment)\b/i.test(s)) || '';
    const candidateDeadline = a.deadline && typeof a.deadline === 'string' ? a.deadline.trim().slice(0, 100) : null;
    const deadlineVerified = Boolean(candidateDeadline && normalize(doc.text).includes(normalize(candidateDeadline)));
    return {
      id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
      title: String(a.title || 'Review document action').slice(0, 140),
      description: String(a.description || 'Review this suggested action against its source.').slice(0, 500),
      deadline: deadlineVerified ? candidateDeadline : null,
      deadlineVerified,
      priority: ['Urgent', 'Normal', 'Can wait', 'Needs review'].includes(a.priority) ? a.priority : 'Needs review',
      category: ['Task', 'Reply', 'Read', 'Payment', 'Appointment'].includes(a.category) ? a.category : 'Task',
      evidence: safeEvidence,
      evidenceVerified: Boolean(verified),
      page: safeEvidence ? findPage(doc, safeEvidence) : null,
      source: doc.name,
      draft: String(a.draft || '').slice(0, 3000),
      status: 'Needs review'
    };
  }).filter(a => a.evidence);
  return { summary: String(parsed.summary || 'Document analyzed. Review the extracted actions below.'), actions };
}

app.get('/api/health', async (_req, res) => {
  let ollama = { connected: false, model: OLLAMA_MODEL };
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1800) });
    if (r.ok) {
      const data = await r.json();
      ollama.connected = true;
      ollama.models = (data.models || []).map(m => m.name);
      ollama.modelInstalled = ollama.models.some(n => n === OLLAMA_MODEL || n.startsWith(`${OLLAMA_MODEL}:`));
    }
  } catch { /* status remains disconnected */ }
  res.json({ ok: true, service: 'Obligation Zero API', ollama, supported: ['pdf', 'docx', 'txt', 'md', 'csv', 'eml'] });
});

app.post('/api/analyze', upload.array('files', 10), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Choose at least one document to analyze.' });
  try {
    const documents = [];
    const actions = [];
    for (const file of req.files) {
      const doc = await extractFile(file);
      let analysis;
      let mode = 'ollama';
      try { analysis = await analyzeWithOllama(doc); }
      
      catch (error) {
        // Return useful extracted findings if Ollama is unavailable, but label fallback honestly.
        console.error('[Obligation Zero] AI analysis failed:', error);
        mode = 'local-rule-fallback';
        analysis = { summary: 'Text extracted. Ollama was unavailable, so these are keyword-based suggestions rather than model analysis.', actions: localFallback(doc).map(a => ({ ...a, source: doc.name, evidenceVerified: true, status: 'Needs review' })) };
        analysis.warning = error.message;
      }
      const docId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const docResult = { id: docId, name: doc.name, size: doc.size, type: doc.type, characters: doc.text.length, summary: analysis.summary, mode, warning: analysis.warning || null, actionCount: analysis.actions.length, preview: doc.text.slice(0, 500) };
      documents.push(docResult);
      for (const action of analysis.actions) actions.push({ ...action, documentId: docId, source: doc.name });
    }
    res.json({ documents, actions, model: OLLAMA_MODEL, processedAt: new Date().toISOString() });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not analyze the selected documents.' });
  }
});

app.post('/api/draft', async (req, res) => {
  const { sourceText = '', action = '', tone = 'Professional' } = req.body || {};
  if (!sourceText.trim() || !action.trim()) return res.status(400).json({ error: 'Source text and action are required.' });
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, messages: [{ role: 'system', content: 'Draft a concise reply based only on supplied context. Do not invent commitments or claim actions have happened. Return only the reply body.' }, { role: 'user', content: `Tone: ${tone}\nAction: ${action}\nSource: ${sourceText.slice(0, 10000)}\nWrite a reply draft.` }], options: { temperature: 0.3 } }) });
    if (!r.ok) throw new Error('Ollama is unavailable. Start Ollama and install the configured model.');
    const data = await r.json();
    res.json({ draft: data.message?.content?.trim() || '' });
  } catch (e) { res.status(503).json({ error: e.message || 'Could not generate draft.' }); }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, '../dist');
if (process.env.SERVE_FRONTEND === 'true') {
  app.use(express.static(distPath));
  app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
}
app.listen(PORT, () => console.log(`Obligation Zero API listening on http://localhost:${PORT}\nOllama: ${OLLAMA_URL} | Model: ${OLLAMA_MODEL}`));
