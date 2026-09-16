// ADACEEN | Capa 1 - Estado: utilidades de texto, numeros y URLs compartidas por todo el overlay.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCodeLine(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+$/g, "");
}

function toText(value) {
  return String(value || "").trim();
}

/** Primer valor finito y mayor que cero de la lista, o null si no hay ninguno. */

function truncateText(value, max = 280) {
  const text = toText(value);
  if (!text) return "";
  if (!Number.isFinite(max) || max <= 0) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function normalizeBaseUrl(value) {
  return toText(value).replace(/\/+$/, "");
}

function unique(items) {
  return [...new Set(items.filter(Boolean).map((item) => toText(item)))];
}

function basename(path) {
  const clean = toText(path);
  if (!clean) return "";
  const parts = clean.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function getExtension(path) {
  const file = basename(path);
  const dot = file.lastIndexOf(".");
  if (dot < 0) return "";
  return file.slice(dot).toLowerCase();
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
