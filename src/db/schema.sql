-- Enable pgvector extension for face embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- Photos table
CREATE TABLE IF NOT EXISTS photos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    s3_path TEXT NOT NULL UNIQUE,
    taken_at TIMESTAMP,
    location_lat DOUBLE PRECISION,
    location_lng DOUBLE PRECISION,
    location_name TEXT,
    description TEXT,
    thumbnail BYTEA,
    process_version TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Faces detected in photos
CREATE TABLE IF NOT EXISTS faces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    photo_id UUID REFERENCES photos(id) ON DELETE CASCADE,
    bounding_box JSONB,
    embedding VECTOR(512),
    person_id UUID,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Known persons (filled by user in UI)
CREATE TABLE IF NOT EXISTS persons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Tags for photos
CREATE TABLE IF NOT EXISTS tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Junction table for photo-tag relationship
CREATE TABLE IF NOT EXISTS photo_tags (
    photo_id UUID REFERENCES photos(id) ON DELETE CASCADE,
    tag_id UUID REFERENCES tags(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (photo_id, tag_id)
);

-- Add foreign key constraint after persons table exists (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_faces_person'
    ) THEN
        ALTER TABLE faces
            ADD CONSTRAINT fk_faces_person
            FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Migrations: add columns that may be missing on existing databases
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'photos' AND column_name = 'process_version'
    ) THEN
        ALTER TABLE photos ADD COLUMN process_version TEXT;
    END IF;
END $$;

-- Migration: face embeddings from 128-dim (face-api.js) to 512-dim (InsightFace)
-- Existing 128-dim embeddings are incompatible; truncate faces and widen the column.
-- Only runs when the column is actually 128-dim (safe to re-run).
DO $$
DECLARE
    current_dim INTEGER;
BEGIN
    -- Get the current dimension of the embedding column from pg_attribute + atttypmod
    SELECT atttypmod INTO current_dim
    FROM pg_attribute
    WHERE attrelid = 'faces'::regclass
      AND attname = 'embedding'
      AND NOT attisdropped;

    -- pgvector stores dimension in atttypmod; only migrate if it's 128
    IF current_dim IS NOT NULL AND current_dim = 128 THEN
        TRUNCATE TABLE faces;
        ALTER TABLE faces ALTER COLUMN embedding TYPE VECTOR(512);
    END IF;
END $$;

-- Migration: add width/height columns for original image dimensions
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'photos' AND column_name = 'width'
    ) THEN
        ALTER TABLE photos ADD COLUMN width INTEGER;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'photos' AND column_name = 'height'
    ) THEN
        ALTER TABLE photos ADD COLUMN height INTEGER;
    END IF;
END $$;

-- Face clusters: groups of visually similar faces
CREATE TABLE IF NOT EXISTS face_clusters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID REFERENCES persons(id) ON DELETE SET NULL,
    representative_embedding VECTOR(512),
    created_at TIMESTAMP DEFAULT NOW()
);

-- User rejected a face from a cluster ("not this person")
CREATE TABLE IF NOT EXISTS face_rejections (
    face_id UUID REFERENCES faces(id) ON DELETE CASCADE,
    cluster_id UUID REFERENCES face_clusters(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (face_id, cluster_id)
);

-- User confirmed a face belongs in a cluster (locked across reclusters)
CREATE TABLE IF NOT EXISTS face_manual_assignments (
    face_id UUID PRIMARY KEY REFERENCES faces(id) ON DELETE CASCADE,
    cluster_id UUID REFERENCES face_clusters(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Migration: add cluster_id column to faces table
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'faces' AND column_name = 'cluster_id'
    ) THEN
        ALTER TABLE faces ADD COLUMN cluster_id UUID;
    END IF;
END $$;

-- Add foreign key constraint for cluster_id (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_faces_cluster'
    ) THEN
        ALTER TABLE faces
            ADD CONSTRAINT fk_faces_cluster
            FOREIGN KEY (cluster_id) REFERENCES face_clusters(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at);
CREATE INDEX IF NOT EXISTS idx_photos_s3_path ON photos(s3_path);
CREATE INDEX IF NOT EXISTS idx_photos_process_version ON photos(process_version);
CREATE INDEX IF NOT EXISTS idx_faces_photo_id ON faces(photo_id);
CREATE INDEX IF NOT EXISTS idx_faces_person_id ON faces(person_id);
CREATE INDEX IF NOT EXISTS idx_photo_tags_tag_id ON photo_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_faces_cluster_id ON faces(cluster_id);

-- HNSW index for fast cosine similarity search on face embeddings
CREATE INDEX IF NOT EXISTS idx_faces_embedding_cosine
    ON faces USING hnsw (embedding vector_cosine_ops);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for photos updated_at
DROP TRIGGER IF EXISTS update_photos_updated_at ON photos;
CREATE TRIGGER update_photos_updated_at
    BEFORE UPDATE ON photos
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
