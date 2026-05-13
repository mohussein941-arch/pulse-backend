// routes/tasks.js — manual CSM tasks (account-linked or standalone)

const express  = require('express');
const router   = express.Router();
const supabase = require('../supabase');
const { schemas, validate, validateUuidParam } = require('../utils/validate');
const { audit } = require('../middleware/audit');

// GET /api/tasks — all tasks for this user
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('user_id', req.userId)
      .order('due_date', { ascending: true, nullsFirst: false });

    if (error) throw error;
    res.json(data.map(shape));
  } catch (err) { next(err); }
});

// POST /api/tasks
router.post('/', validate(schemas.taskCreate), async (req, res, next) => {
  try {
    const { title, description, priority, dueDate, accountId } = req.body;

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        user_id:     req.userId,
        account_id:  accountId || null,
        title,
        description: description || null,
        priority,
        due_date:    dueDate || null,
      })
      .select().single();

    if (error) throw error;
    audit(req.userId, 'task.created', { resourceType: 'task', resourceId: data.id, req });
    res.status(201).json(shape(data));
  } catch (err) { next(err); }
});

// PATCH /api/tasks/:id
router.patch('/:id', validateUuidParam('id'), validate(schemas.taskUpdate), async (req, res, next) => {
  try {
    const updates = {};
    if ('done'        in req.body) updates.done        = req.body.done;
    if ('title'       in req.body) updates.title       = req.body.title;
    if ('description' in req.body) updates.description = req.body.description;
    if ('priority'    in req.body) updates.priority    = req.body.priority;
    if ('dueDate'     in req.body) updates.due_date    = req.body.dueDate;

    const { data, error } = await supabase
      .from('tasks')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .select().single();

    if (error) throw error;
    if (!data)  return res.status(404).json({ error: 'Task not found' });
    audit(req.userId, 'task.updated', { resourceType: 'task', resourceId: req.params.id, req });
    res.json(shape(data));
  } catch (err) { next(err); }
});

// DELETE /api/tasks/:id
router.delete('/:id', validateUuidParam('id'), async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);

    if (error) throw error;
    audit(req.userId, 'task.deleted', { resourceType: 'task', resourceId: req.params.id, req });
    res.status(204).send();
  } catch (err) { next(err); }
});

function shape(t) {
  return {
    id:          t.id,
    accountId:   t.account_id || null,
    title:       t.title,
    description: t.description || '',
    priority:    t.priority,
    dueDate:     t.due_date || null,
    done:        t.done,
    createdAt:   t.created_at,
  };
}

module.exports = router;
