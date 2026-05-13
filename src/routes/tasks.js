// routes/tasks.js — manual CSM tasks (account-linked or standalone)

const express  = require('express');
const router   = express.Router();
const supabase = require('../supabase');

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
router.post('/', async (req, res, next) => {
  try {
    const { title, description, priority, dueDate, accountId } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'title required' });

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        user_id:    req.userId,
        account_id: accountId || null,
        title:      title.trim(),
        description: description || null,
        priority:   priority || 'High',
        due_date:   dueDate || null,
      })
      .select().single();

    if (error) throw error;
    res.status(201).json(shape(data));
  } catch (err) { next(err); }
});

// PATCH /api/tasks/:id
router.patch('/:id', async (req, res, next) => {
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
    res.json(shape(data));
  } catch (err) { next(err); }
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);

    if (error) throw error;
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
