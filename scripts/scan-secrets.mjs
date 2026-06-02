#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.ico', '.zip', '.gz', '.7z',
    '.pdf', '.mp3', '.mp4', '.mov', '.woff', '.woff2', '.ttf',
]);

const SECRET_PATTERNS = [
    { name: 'OpenAI-style API key', regex: /\bsk-[A-Za-z0-9_-]{24,}\b/g },
    { name: 'Anthropic API key', regex: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/g },
    { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{24,}\b/g },
    { name: 'GitHub token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{24,}\b/g },
    { name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{24,}\b/g },
    { name: 'Private key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |)?PRIVATE KEY-----/g },
    { name: 'Bearer token', regex: /\bBearer\s+[A-Za-z0-9._~+/-]{32,}={0,2}\b/g },
];

function gitFiles() {
    const output = execSync('git ls-files --cached --others --exclude-standard', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.split(/\r?\n/).filter(Boolean);
}

function shouldSkip(file) {
    const ext = extname(file).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return true;
    try {
        return statSync(file).size > MAX_FILE_BYTES;
    } catch {
        return true;
    }
}

function redact(value) {
    const compact = value.replace(/\s+/g, ' ').trim();
    if (compact.length <= 16) return '<redacted>';
    return `${compact.slice(0, 8)}...${compact.slice(-4)}`;
}

function lineNumberForIndex(text, index) {
    let line = 1;
    for (let i = 0; i < index; i += 1) {
        if (text.charCodeAt(i) === 10) line += 1;
    }
    return line;
}

const findings = [];

for (const file of gitFiles()) {
    if (shouldSkip(file)) continue;

    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch {
        continue;
    }

    if (text.includes('\u0000')) continue;

    for (const pattern of SECRET_PATTERNS) {
        pattern.regex.lastIndex = 0;
        for (const match of text.matchAll(pattern.regex)) {
            findings.push({
                file,
                line: lineNumberForIndex(text, match.index || 0),
                name: pattern.name,
                value: redact(match[0]),
            });
        }
    }
}

if (findings.length) {
    console.error('Potential secrets found:');
    for (const finding of findings) {
        console.error(`${finding.file}:${finding.line} ${finding.name}: ${finding.value}`);
    }
    process.exit(1);
}

console.log('No high-confidence secrets found.');
