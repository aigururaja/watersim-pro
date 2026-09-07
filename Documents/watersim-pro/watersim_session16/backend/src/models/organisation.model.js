const { query } = require('../db/pool');

const OrgModel = {
  async findBySlug(slug) {
    const result = await query(
      'SELECT id, name, slug, settings, is_active FROM organisations WHERE slug = $1',
      [slug]
    );
    return result.rows[0] || null;
  },

  async findById(id) {
    const result = await query(
      'SELECT id, name, slug, settings, is_active FROM organisations WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  },

  /** Every organisation a person may sign in to — slug and name only, for the login page's picker. */
  async listActive() {
    const result = await query(
      'SELECT slug, name FROM organisations WHERE is_active = TRUE ORDER BY LOWER(name), slug'
    );
    return result.rows;
  },

  async create({ name, slug }) {
    const result = await query(
      `INSERT INTO organisations (name, slug)
       VALUES ($1, $2)
       RETURNING id, name, slug, is_active, created_at`,
      [name, slug]
    );
    return result.rows[0];
  },
};

module.exports = OrgModel;
