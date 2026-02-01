import { query } from "./client.js";

export interface PersonRecord {
  id: string;
  name: string;
  created_at: Date;
}

export interface PersonWithStats extends PersonRecord {
  face_count: number;
}

export interface FaceWithPhoto {
  id: string;
  photo_id: string;
  bounding_box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  person_id: string | null;
}

export async function getAllPersons(): Promise<PersonWithStats[]> {
  const result = await query<PersonWithStats>(
    `SELECT
      p.id,
      p.name,
      p.created_at,
      (SELECT COUNT(*)::int FROM faces f WHERE f.person_id = p.id) as face_count
    FROM persons p
    ORDER BY p.name`
  );
  return result.rows;
}

export async function getPersonById(id: string): Promise<PersonWithStats | null> {
  const result = await query<PersonWithStats>(
    `SELECT
      p.id,
      p.name,
      p.created_at,
      (SELECT COUNT(*)::int FROM faces f WHERE f.person_id = p.id) as face_count
    FROM persons p
    WHERE p.id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function createPerson(name: string): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO persons (name) VALUES ($1) RETURNING id`,
    [name.trim()]
  );
  return result.rows[0].id;
}

export async function updatePerson(id: string, name: string): Promise<void> {
  await query(
    `UPDATE persons SET name = $1 WHERE id = $2`,
    [name.trim(), id]
  );
}

export async function deletePerson(id: string): Promise<void> {
  await query(`DELETE FROM persons WHERE id = $1`, [id]);
}

export async function assignFaceToPerson(faceId: string, personId: string | null): Promise<void> {
  await query(
    `UPDATE faces SET person_id = $1 WHERE id = $2`,
    [personId, faceId]
  );
}

export async function getPhotosByPerson(personId: string): Promise<{ id: string; s3_path: string; taken_at: Date | null }[]> {
  const result = await query<{ id: string; s3_path: string; taken_at: Date | null }>(
    `SELECT DISTINCT p.id, p.s3_path, p.taken_at
    FROM photos p
    JOIN faces f ON f.photo_id = p.id
    WHERE f.person_id = $1
    ORDER BY p.taken_at DESC NULLS LAST`,
    [personId]
  );
  return result.rows;
}

export async function getUnassignedFaces(limit: number = 50): Promise<FaceWithPhoto[]> {
  const result = await query<FaceWithPhoto>(
    `SELECT f.id, f.photo_id, f.bounding_box, f.person_id
    FROM faces f
    WHERE f.person_id IS NULL
    ORDER BY f.created_at DESC
    LIMIT $1`,
    [limit]
  );
  return result.rows;
}
