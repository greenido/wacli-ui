import { Router, type Request, type Response, type NextFunction } from 'express';
import { parseTemplateInput, templateStore, type TemplateStore } from '../wacli/templates.js';

/**
 * Quick-reply templates.
 *
 * Mission Control's own file, never wacli's or WhatsApp's, so these stay open
 * in safe read-only mode and while asleep — the same footing as bookmarks and
 * tags. Using a template only fills the composer; the send that follows goes
 * through the confirm dialog and every guard like any other.
 */
export function createTemplatesRouter(store: TemplateStore = templateStore): Router {
  const router = Router();

  function notFound(res: Response): void {
    res.status(404).json({ success: false, data: null, error: 'No such template.', code: 'NOT_FOUND' });
  }

  router.get('/templates', (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: store.list(), error: null });
    } catch (err) {
      next(err);
    }
  });

  router.post('/templates', (req: Request, res: Response, next: NextFunction) => {
    const input = parseTemplateInput(req.body);
    if (typeof input === 'string') {
      res.status(400).json({ success: false, data: null, error: input });
      return;
    }
    try {
      res.status(201).json({ success: true, data: store.create(input), error: null });
    } catch (err) {
      next(err);
    }
  });

  router.post('/templates/:id', (req: Request, res: Response, next: NextFunction) => {
    const input = parseTemplateInput(req.body);
    if (typeof input === 'string') {
      res.status(400).json({ success: false, data: null, error: input });
      return;
    }
    try {
      const updated = store.update(String(req.params.id), input);
      if (!updated) {
        notFound(res);
        return;
      }
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/templates/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!store.remove(String(req.params.id))) {
        notFound(res);
        return;
      }
      res.json({ success: true, data: { id: req.params.id, deleted: true }, error: null });
    } catch (err) {
      next(err);
    }
  });

  // Recorded when a template is inserted, not when the message is sent: what
  // the picker should offer first is what the operator reaches for.
  router.post('/templates/:id/use', (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!store.markUsed(String(req.params.id))) {
        notFound(res);
        return;
      }
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
