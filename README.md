# Obligation Zero 🍃

A privacy-first document-to-action assistant. Upload everyday paperwork, extract text locally, ask an open-weight model served by Ollama to propose action items, and review each suggestion against the original source sentence.

## Stack

- React + Vite + TypeScript frontend
- Express API
- `pdf-parse` for text PDFs, `mammoth` for DOCX, UTF-8 parsing for TXT/MD/CSV/EML
- Ollama local inference; default model `gemma3:4b`
- Browser `localStorage` for action/document metadata. The API processes uploaded file bytes in memory and does not write source files to disk.

## Requirements

- Node.js 20+ (Node 22 recommended)
- Ollama installed and running: https://ollama.com
- A model pulled locally, e.g. `ollama pull gemma3:4b`

## Run locally

Open two terminals in the project root.

Terminal 1 — start Ollama (if it is not already running):

```bash
ollama serve
```

Terminal 2 — install and start the backend:

```bash
npm install
ollama pull gemma3:4b
npm run server
```

Terminal 3 — install/start the frontend:

```bash
npm run dev
```

Open the local URL printed by Vite (this Figma project may use port 8443). The API defaults to `http://localhost:8787`.

To use another API address, create `.env.local` in the project root:

```bash
VITE_API_URL=http://localhost:8787
```

To change the model, set `OLLAMA_MODEL` in your shell before starting the backend. For example, use a model you have already pulled with Ollama.

## API

- `GET /api/health` — API and Ollama/model status
- `POST /api/analyze` — multipart form-data with one or more `files` fields; extracts text and returns document summaries plus evidence-backed action candidates
- `POST /api/draft` — JSON `{ "sourceText": "...", "action": "...", "tone": "Professional" }`; generates an editable reply draft with the local model

## Evidence and limitations

- The model is prompted to return an exact sentence from the source. The API validates the quotation against normalized extracted text and marks whether it matched. Unmatched model quotations are not treated as verified evidence.
- PDF page numbers are best-effort because page boundaries vary by PDF parser and document layout.
- If Ollama is unavailable, the API labels its keyword-based fallback clearly; it is not represented as model inference. Start Ollama and install the configured model for the full open-weight AI path.
- Scanned/image-only PDFs are not OCR'd in this MVP and will return a useful error.
- DOCX files are text-extracted; DOCX page numbers are not available.
- Dates are suggestions, not calendar guarantees. Verify deadlines against the original document before acting.
- Uploaded originals are held in memory only during the request. Extracted document previews, action suggestions, and drafts are stored in this browser's localStorage until cleared in Settings.
- This is a local development app. Do not expose the API publicly without adding authentication, stricter CORS, request limits, and other deployment hardening.

## Demo walkthrough

1. Confirm the Settings screen says Ollama is connected and the configured model is installed.
2. Upload a text-based PDF, DOCX, or TXT file containing a clear obligation or deadline.
3. Click **Process documents** and wait for the result.
4. Open the action queue and choose **Review evidence**.
5. Check the source sentence and evidence-match indicator; edit the suggestion if needed.
6. For a reply-related action, generate a draft and edit/copy it before sending yourself.

No email is sent automatically and no action is completed without a user click.
