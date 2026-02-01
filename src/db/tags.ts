import { query } from "./client.js";

export interface TagRecord {
  id: string;
  name: string;
  created_at: Date;
}

export async function addTagToPhoto(
  photoId: string,
  tagName: string
): Promise<string> {
  // Insert tag if it doesn't exist, then link to photo
  const tagResult = await query<{ id: string }>(
    `INSERT INTO tags (name)
     VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [tagName.toLowerCase().trim()]
  );

  const tagId = tagResult.rows[0].id;

  await query(
    `INSERT INTO photo_tags (photo_id, tag_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [photoId, tagId]
  );

  return tagId;
}

export async function removeTagFromPhoto(
  photoId: string,
  tagId: string
): Promise<void> {
  await query("DELETE FROM photo_tags WHERE photo_id = $1 AND tag_id = $2", [
    photoId,
    tagId,
  ]);
}

export async function getPhotoTags(photoId: string): Promise<TagRecord[]> {
  const result = await query<TagRecord>(
    `SELECT t.* FROM tags t
     JOIN photo_tags pt ON t.id = pt.tag_id
     WHERE pt.photo_id = $1
     ORDER BY t.name`,
    [photoId]
  );

  return result.rows;
}

export async function getPhotosByTag(
  tagName: string
): Promise<{ photo_id: string }[]> {
  const result = await query<{ photo_id: string }>(
    `SELECT pt.photo_id FROM photo_tags pt
     JOIN tags t ON t.id = pt.tag_id
     WHERE t.name = $1`,
    [tagName.toLowerCase().trim()]
  );

  return result.rows;
}

export async function getAllTags(): Promise<TagRecord[]> {
  const result = await query<TagRecord>("SELECT * FROM tags ORDER BY name");
  return result.rows;
}
