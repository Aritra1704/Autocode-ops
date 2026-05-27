import { getPool } from '../db/client.js';

export class ChatHistoryManager {
  constructor(options = {}) {
    this.pool = options.pool ?? getPool();
  }

  /**
   * Appends a message to the persistent chat history for a session.
   */
  async appendMessage(sessionId, role, content, metadata = {}) {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO chat_messages (session_id, role, content, metadata, created_at)
         VALUES ($1, $2, $3, $4::jsonb, NOW())`,
        [sessionId, role, content, JSON.stringify(metadata)]
      );
      
      // Update session last activity
      await client.query(
        `UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`,
        [sessionId]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Retrieves the recent chat history for context injection.
   */
  async getHistory(sessionId, limit = 20) {
    const result = await this.pool.query(
      `SELECT role, content, metadata, created_at
       FROM chat_messages
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [sessionId, limit]
    );
    return result.rows.reverse();
  }

  /**
   * Formats history for LLM prompt injection.
   */
  formatForPrompt(history) {
    if (!history || history.length === 0) return '';
    
    return history
      .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
      .join('\n');
  }
}
