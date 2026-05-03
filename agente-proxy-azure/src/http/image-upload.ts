import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { env } from "../config/env.js";

export function createImageUploadMiddleware() {
  const uploadsDir = path.resolve(env.uploadsDir);
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const allowedMimeTypes = new Set(env.imageUploadAllowedMimeTypes);

  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadsDir),
      filename: (_req, file, cb) => {
        const extension = path.extname(file.originalname || "");
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`);
      },
    }),
    limits: { fileSize: env.imageUploadMaxBytes },
    fileFilter: (_req, file, cb) => cb(null, allowedMimeTypes.has(file.mimetype)),
  });
}
