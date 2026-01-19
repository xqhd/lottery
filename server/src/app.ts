import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import multer from "multer";
import { z } from "zod";
import { config } from "./config.js";
import { ApiError } from "./errors.js";
import type { Store } from "./store.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const backgroundUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(config.uploadDir, { recursive: true });
      cb(null, config.uploadDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ext && ext.length <= 10 ? ext : "";
      cb(null, `${req.params.id}_bg_${Date.now()}${safeExt}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!(file.mimetype.startsWith("image/") || file.mimetype === "video/mp4")) {
      cb(new ApiError(400, "INVALID_FILE_TYPE", "Only image or MP4 uploads are allowed"));
      return;
    }
    cb(null, true);
  }
});

const bgmUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(config.uploadDir, { recursive: true });
      cb(null, config.uploadDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ext && ext.length <= 10 ? ext : "";
      const slot = String((req.params as Record<string, string | undefined>).slot ?? "unknown");
      cb(null, `${req.params.id}_bgm_${slot}_${Date.now()}${safeExt}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const slot = String((req.params as Record<string, string | undefined>).slot ?? "");
    if (!(slot === "ready" || slot === "rolling" || slot === "win")) {
      cb(new ApiError(400, "INVALID_BGM_SLOT", "Invalid bgm slot"));
      return;
    }
    if (!file.mimetype.startsWith("audio/")) {
      cb(new ApiError(400, "INVALID_FILE_TYPE", "Only audio uploads are allowed"));
      return;
    }
    cb(null, true);
  }
});

const prizeMediaUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(config.uploadDir, { recursive: true });
      cb(null, config.uploadDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ext && ext.length <= 10 ? ext : "";
      cb(null, `${req.params.id}_prize_${req.params.prizeId}_${Date.now()}${safeExt}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!(file.mimetype.startsWith("image/") || file.mimetype === "video/mp4")) {
      cb(new ApiError(400, "INVALID_FILE_TYPE", "Only image or MP4 uploads are allowed"));
      return;
    }
    cb(null, true);
  }
});

function actorFromReq(req: express.Request): string {
  const actor = req.header("x-actor");
  return actor ? actor.trim() : "";
}

function wrap(handler: (req: express.Request, res: express.Response) => void): express.RequestHandler {
  return (req, res, next) => {
    try {
      handler(req, res);
    } catch (err) {
      next(err);
    }
  };
}

export function createApp(store: Store) {
  const app = express();
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: "10mb" }));
  app.use("/uploads", express.static(config.uploadDir));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post(
    "/api/v1/events",
    wrap((req, res) => {
      const body = z
        .object({
          name: z.string().trim().min(1),
          description: z.string().trim().optional()
        })
        .parse(req.body);

      const event = store.createEvent(body);
      res.status(201).json({ event });
    })
  );

  app.get(
    "/api/v1/events",
    wrap((_req, res) => {
      const events = store.listEvents();
      res.json({ events });
    })
  );

  app.post(
    "/api/v1/events/import",
    wrap((req, res) => {
      const body = z
        .object({
          bundle: z.object({
            version: z.literal(1),
            exportedAt: z.string().optional(),
            event: z.object({
              name: z.string().trim().min(1),
              description: z.string().trim().optional(),
              settingsJson: z.string().optional()
            }),
            prizes: z
              .array(
                z.object({
                  name: z.string().trim().min(1),
                  level: z.number().int().optional(),
                  quantity: z.number().int().positive(),
                  weight: z.number().positive().optional(),
                  allowRepeat: z.boolean().optional(),
                  mediaUrl: z.string().trim().optional()
                })
              )
              .default([]),
            participants: z
              .array(
                z.object({
                  name: z.string().trim().min(1),
                  employeeId: z.string().optional().default(""),
                  department: z.string().optional().default(""),
                  weight: z.number().optional()
                })
              )
              .default([])
          })
        })
        .parse(req.body);

      const event = store.importEventBundle(body.bundle, actorFromReq(req));
      res.status(201).json({ event });
    })
  );

  app.get(
    "/api/v1/events/:id",
    wrap((req, res) => {
      const event = store.getEvent(req.params.id);
      if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
      res.json({ event });
    })
  );

  const deleteEventHandler = wrap((req, res) => {
    const result = store.deleteEvent(req.params.id, actorFromReq(req));
    res.json({ result });
  });

  app.delete("/api/v1/events/:id", deleteEventHandler);
  // Back-compat / ergonomic alias.
  app.delete("/api/events/:id", deleteEventHandler);

  app.get(
    "/api/v1/events/:id/export",
    wrap((req, res) => {
      const bundle = store.exportEventBundle(req.params.id);
      res.json({ bundle });
    })
  );

  app.post(
    "/api/v1/events/:id/prizes",
    wrap((req, res) => {
      const body = z
        .object({
          name: z.string().trim().min(1),
          level: z.number().int().optional(),
          quantity: z.number().int().positive(),
          weight: z.number().positive().optional(),
          allowRepeat: z.boolean().optional()
        })
        .parse(req.body);

      const prize = store.createPrize(req.params.id, body);
      res.status(201).json({ prize });
    })
  );

  app.post(
    "/api/v1/events/:id/prizes/:prizeId/media",
    prizeMediaUpload.single("file"),
    wrap((req, res) => {
      if (!req.file) throw new ApiError(400, "MISSING_FILE", "Missing file");

      const url = `/uploads/${req.file.filename}`;
      const prize = store.setPrizeMedia(req.params.id, req.params.prizeId, url, actorFromReq(req));
      res.json({ url, prize });
    })
  );

  app.patch(
    "/api/v1/events/:id/prizes/:prizeId",
    wrap((req, res) => {
      const body = z
        .object({
          name: z.string().trim().min(1).optional(),
          level: z.number().int().optional(),
          quantity: z.number().int().positive().optional(),
          weight: z.number().positive().optional(),
          allowRepeat: z.boolean().optional()
        })
        .parse(req.body);

      const prize = store.updatePrize(req.params.id, req.params.prizeId, body, actorFromReq(req));
      res.json({ prize });
    })
  );

  app.get(
    "/api/v1/events/:id/prizes",
    wrap((req, res) => {
      const prizes = store.listPrizes(req.params.id);
      res.json({ prizes });
    })
  );

  app.post(
    "/api/v1/events/:id/background",
    backgroundUpload.single("file"),
    wrap((req, res) => {
      if (!req.file) throw new ApiError(400, "MISSING_FILE", "Missing file");

      const url = `/uploads/${req.file.filename}`;
      const event = store.setEventBackground(req.params.id, url, actorFromReq(req));
      res.json({ url, event });
    })
  );

  app.post(
    "/api/v1/events/:id/bgm/:slot",
    bgmUpload.single("file"),
    wrap((req, res) => {
      const slot = z.enum(["ready", "rolling", "win"]).parse(req.params.slot);
      if (!req.file) throw new ApiError(400, "MISSING_FILE", "Missing file");

      const url = `/uploads/${req.file.filename}`;
      const event = store.setEventBgm(req.params.id, slot, url, actorFromReq(req));
      res.json({ url, event });
    })
  );

  app.patch(
    "/api/v1/events/:id/stage-effects",
    wrap((req, res) => {
      const body = z
        .object({
          stageEffects: z
            .object({
              confettiEnabled: z.boolean().optional(),
              confettiIntensity: z.number().min(0.5).max(2.0).optional(),
              theme: z.enum(["gold", "festive", "simple"]).optional()
            })
            .strict()
        })
        .parse(req.body);

      const event = store.setStageEffects(req.params.id, body.stageEffects, actorFromReq(req));
      res.json({ event });
    })
  );

  app.post(
    "/api/v1/events/:id/import",
    upload.single("file"),
    wrap((req, res) => {
      if (!req.file) throw new ApiError(400, "MISSING_FILE", "Missing file");
      const result = store.importParticipants(req.params.id, req.file, actorFromReq(req));
      res.json({ result });
    })
  );

  app.post(
    "/api/v1/events/:id/participants/batch",
    wrap((req, res) => {
      const body = z
        .object({
          participants: z.array(
            z.object({
              name: z.unknown(),
              seq: z.unknown().optional(),
              employeeId: z.unknown().optional(),
              employee_id: z.unknown().optional(),
              department: z.unknown().optional(),
              weight: z.unknown().optional()
            })
          )
        })
        .parse(req.body);

      const coerceString = (value: unknown): string => {
        if (value === null || value === undefined) return "";
        if (typeof value === "string") return value.trim();
        if (typeof value === "number") return String(value).trim();
        return String(value).trim();
      };

      const coerceWeight = (value: unknown): number | undefined => {
        if (value === null || value === undefined) return undefined;
        if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
        const str = coerceString(value);
        if (!str) return undefined;
        const num = Number(str);
        return Number.isFinite(num) ? num : undefined;
      };

      const coerceSeq = (value: unknown): number | undefined => {
        if (value === null || value === undefined) return undefined;
        if (typeof value === "number") {
          if (!Number.isFinite(value)) return undefined;
          const n = Math.floor(value);
          return n > 0 ? n : undefined;
        }
        const str = coerceString(value);
        if (!str) return undefined;
        const num = Number(str);
        if (!Number.isFinite(num)) return undefined;
        const n = Math.floor(num);
        return n > 0 ? n : undefined;
      };

      const participants = body.participants.map((p) => ({
        seq: coerceSeq(p.seq),
        name: coerceString(p.name),
        employeeId: coerceString(p.employeeId ?? p.employee_id),
        department: coerceString(p.department),
        weight: coerceWeight(p.weight)
      }));

      const result = store.batchImportParticipants(req.params.id, participants, actorFromReq(req));
      res.json({ result });
    })
  );

  const listParticipantsHandler = wrap((req, res) => {
    const shouldPage = req.query.page !== undefined || req.query.limit !== undefined || req.query.q !== undefined;
    if (!shouldPage) {
      const participants = store.listParticipants(req.params.id);
      res.json({ participants });
      return;
    }

    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        q: z.string().optional()
      })
      .parse(req.query);

    const { participants, total } = store.listParticipantsPaged(req.params.id, {
      page: query.page,
      limit: query.limit,
      q: query.q
    });

    res.json({ participants, total, page: query.page, limit: query.limit, q: query.q ?? "" });
  });

  app.get("/api/v1/events/:id/participants", listParticipantsHandler);
  // Back-compat / ergonomic alias.
  app.get("/api/events/:id/participants", listParticipantsHandler);

  const updateParticipantHandler = wrap((req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(1).optional(),
        employeeId: z.string().trim().optional(),
        employee_id: z.string().trim().optional(),
        department: z.string().trim().optional(),
        weight: z.coerce.number().positive().optional()
      })
      .parse(req.body);

    const participant = store.updateParticipant(
      req.params.id,
      {
        name: body.name,
        employeeId: body.employeeId ?? body.employee_id,
        department: body.department,
        weight: body.weight
      },
      actorFromReq(req)
    );

    res.json({ participant });
  });

  app.put("/api/v1/participants/:id", updateParticipantHandler);
  app.put("/api/participants/:id", updateParticipantHandler);

  const deleteParticipantHandler = wrap((req, res) => {
    const result = store.deleteParticipant(req.params.id, actorFromReq(req));
    res.json({ result });
  });

  app.delete("/api/v1/participants/:id", deleteParticipantHandler);
  app.delete("/api/participants/:id", deleteParticipantHandler);

  const clearEventParticipantsHandler = wrap((req, res) => {
    const result = store.clearEventParticipants(req.params.id, actorFromReq(req));
    res.json({ result });
  });

  app.delete("/api/v1/events/:id/participants", clearEventParticipantsHandler);
  app.delete("/api/events/:id/participants", clearEventParticipantsHandler);

  app.get(
    "/api/v1/events/:id/participants/sample",
    wrap((req, res) => {
      const limit = z.coerce.number().int().min(1).max(200).default(80).parse(req.query.limit);
      const participants = store.sampleParticipants(req.params.id, limit);
      res.json({ participants });
    })
  );

  app.get(
    "/api/v1/events/:id/participants/stats",
    wrap((req, res) => {
      const stats = store.getParticipantStats(req.params.id);
      res.json(stats);
    })
  );

  app.get(
    "/api/v1/events/:id/results",
    wrap((req, res) => {
      const includeDeleted = req.query.includeDeleted === "true";
      const results = store.listResults(req.params.id, { includeDeleted });
      res.json({ results });
    })
  );

  app.put(
    "/api/v1/results/:id/delete",
    wrap((req, res) => {
      const result = store.deleteResult(req.params.id, actorFromReq(req));
      res.json({ result });
    })
  );

  app.put(
    "/api/v1/results/:id/restore",
    wrap((req, res) => {
      const result = store.restoreResult(req.params.id, actorFromReq(req));
      res.json({ result });
    })
  );

  app.post(
    "/api/v1/events/:id/reset",
    wrap((req, res) => {
      const result = store.clearEventResults(req.params.id, actorFromReq(req));
      res.json({ result });
    })
  );

  app.get(
    "/api/v1/events/:id/status",
    wrap((req, res) => {
      const status = store.getStageStatus(req.params.id);
      res.json(status);
    })
  );

  app.post(
    "/api/v1/events/:id/start-rolling",
    wrap((req, res) => {
      const body = z
        .object({
          prizeId: z.string().min(1)
        })
        .parse(req.body);

      const result = store.startRolling(req.params.id, body.prizeId, actorFromReq(req));
      res.json(result);
    })
  );

  app.post(
    "/api/v1/events/:id/stage/idle",
    wrap((req, res) => {
      const result = store.setStageIdle(req.params.id, actorFromReq(req));
      res.json({ result });
    })
  );

  app.post(
    "/api/v1/events/:id/draw",
    wrap((req, res) => {
      const body = z
        .object({
          prizeId: z.string().min(1),
          count: z.number().int().positive().optional(),
          seed: z.string().trim().optional()
        })
        .parse(req.body);

      const result = store.drawWinners({
        eventId: req.params.id,
        prizeId: body.prizeId,
        count: body.count,
        seed: body.seed,
        actor: actorFromReq(req)
      });

      res.json(result);
    })
  );

  app.use((_req, _res, next) => {
    next(new ApiError(404, "NOT_FOUND", "Not found"));
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }

    if (err instanceof z.ZodError) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid request", details: err.flatten() } });
      return;
    }

    console.error(err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal error" } });
  });

  return app;
}
