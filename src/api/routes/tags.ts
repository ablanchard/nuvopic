import { Hono } from "hono";
import {
  getAllTags,
  getPhotoTags,
  getPhotosByTag,
  addTagToPhoto,
  removeTagFromPhoto,
} from "../../db/tags.js";

const tags = new Hono();

// List all tags
tags.get("/", async (c) => {
  const tagsList = await getAllTags();
  return c.json({
    tags: tagsList.map((t) => ({
      id: t.id,
      name: t.name,
    })),
  });
});

// Get photos by tag name
tags.get("/:name/photos", async (c) => {
  const name = c.req.param("name");
  const photos = await getPhotosByTag(decodeURIComponent(name));

  return c.json({
    photos: photos.map((p) => ({
      id: p.photo_id,
      thumbnailUrl: `/api/v1/photos/${p.photo_id}/thumbnail`,
    })),
  });
});

// Get tags for a photo
tags.get("/photo/:photoId", async (c) => {
  const photoId = c.req.param("photoId");
  const photoTags = await getPhotoTags(photoId);

  return c.json({
    tags: photoTags.map((t) => ({
      id: t.id,
      name: t.name,
    })),
  });
});

// Add tag to photo
tags.post("/photo/:photoId", async (c) => {
  const photoId = c.req.param("photoId");
  const body = await c.req.json<{ name: string }>();

  if (!body.name?.trim()) {
    return c.json({ error: "Tag name is required" }, 400);
  }

  const tagId = await addTagToPhoto(photoId, body.name);
  return c.json({ id: tagId, name: body.name.trim() }, 201);
});

// Remove tag from photo
tags.delete("/photo/:photoId/:tagId", async (c) => {
  const photoId = c.req.param("photoId");
  const tagId = c.req.param("tagId");

  await removeTagFromPhoto(photoId, tagId);
  return c.json({ success: true });
});

export default tags;
