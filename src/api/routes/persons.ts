import { Hono } from "hono";
import {
  getAllPersons,
  getPersonById,
  createPerson,
  updatePerson,
  deletePerson,
  getPhotosByPerson,
  assignFaceToPerson,
  getUnassignedFaces,
} from "../../db/persons.js";

const persons = new Hono();

// List all persons
persons.get("/", async (c) => {
  const personsList = await getAllPersons();
  return c.json({
    persons: personsList.map((p) => ({
      id: p.id,
      name: p.name,
      faceCount: p.face_count,
    })),
  });
});

// Get unassigned faces
persons.get("/unassigned-faces", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const faces = await getUnassignedFaces(Math.min(limit, 100));
  return c.json({
    faces: faces.map((f) => ({
      id: f.id,
      photoId: f.photo_id,
      boundingBox: f.bounding_box,
      thumbnailUrl: `/api/v1/photos/${f.photo_id}/thumbnail`,
    })),
  });
});

// Get single person
persons.get("/:id", async (c) => {
  const id = c.req.param("id");
  const person = await getPersonById(id);

  if (!person) {
    return c.json({ error: "Person not found" }, 404);
  }

  return c.json({
    id: person.id,
    name: person.name,
    faceCount: person.face_count,
  });
});

// Get photos for a person
persons.get("/:id/photos", async (c) => {
  const id = c.req.param("id");
  const photos = await getPhotosByPerson(id);

  return c.json({
    photos: photos.map((p) => ({
      id: p.id,
      s3Path: p.s3_path,
      thumbnailUrl: `/api/v1/photos/${p.id}/thumbnail`,
      takenAt: p.taken_at,
    })),
  });
});

// Create person
persons.post("/", async (c) => {
  const body = await c.req.json<{ name: string }>();

  if (!body.name?.trim()) {
    return c.json({ error: "Name is required" }, 400);
  }

  const id = await createPerson(body.name);
  return c.json({ id, name: body.name.trim() }, 201);
});

// Update person
persons.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ name: string }>();

  if (!body.name?.trim()) {
    return c.json({ error: "Name is required" }, 400);
  }

  await updatePerson(id, body.name);
  return c.json({ id, name: body.name.trim() });
});

// Delete person
persons.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await deletePerson(id);
  return c.json({ success: true });
});

// Assign face to person
persons.post("/faces/:faceId/assign", async (c) => {
  const faceId = c.req.param("faceId");
  const body = await c.req.json<{ personId: string | null }>();

  await assignFaceToPerson(faceId, body.personId);
  return c.json({ success: true });
});

export default persons;
