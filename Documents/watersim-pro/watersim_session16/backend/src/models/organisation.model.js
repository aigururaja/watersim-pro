const { query } = require('../db');

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
