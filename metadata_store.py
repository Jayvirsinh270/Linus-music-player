import os
from contextlib import contextmanager


MYSQL_CONFIG = {
    "host": os.getenv("LINUS_MYSQL_HOST", "127.0.0.1"),
    "port": int(os.getenv("LINUS_MYSQL_PORT", "3306")),
    "user": os.getenv("LINUS_MYSQL_USER", "root"),
    "password": os.getenv("LINUS_MYSQL_PASSWORD", ""),
    "database": os.getenv("LINUS_MYSQL_DATABASE", "linus"),
    "connect_timeout": 2,
    "autocommit": True,
}


@contextmanager
def connection():
    try:
        import pymysql
        client = pymysql.connect(**MYSQL_CONFIG)
    except Exception:
        yield None
        return
    try:
        yield client
    finally:
        client.close()


def available():
    with connection() as client:
        if client is None:
            return False
        try:
            with client.cursor() as cursor:
                cursor.execute("SELECT 1")
            return True
        except Exception:
            return False


def ensure_schema():
    with connection() as client:
        if client is None:
            try:
                import pymysql
                bootstrap = dict(MYSQL_CONFIG)
                bootstrap.pop("database")
                with pymysql.connect(**bootstrap) as root_client:
                    with root_client.cursor() as cursor:
                        database = MYSQL_CONFIG["database"].replace("`", "``")
                        cursor.execute(f"CREATE DATABASE IF NOT EXISTS `{database}` CHARACTER SET utf8mb4")
                return ensure_schema()
            except Exception:
                return False
        try:
            with client.cursor() as cursor:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS tracks (
                        id VARCHAR(512) PRIMARY KEY,
                        title VARCHAR(255) NOT NULL,
                        artist VARCHAR(255) NOT NULL,
                        album VARCHAR(255) NOT NULL,
                        extension VARCHAR(12) NOT NULL,
                        duration_seconds DECIMAL(10, 2) NULL,
                        artwork_url VARCHAR(512) NULL,
                        first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
            return True
        except Exception:
            return False


def save_tracks(tracks):
    if not ensure_schema():
        return False
    with connection() as client:
        if client is None:
            return False
        try:
            with client.cursor() as cursor:
                cursor.executemany("""
                    INSERT INTO tracks (id, title, artist, album, extension)
                    VALUES (%s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                        title = VALUES(title), artist = VALUES(artist),
                        album = VALUES(album), extension = VALUES(extension)
                """, [(track["id"], track["title"], track["artist"], track["album"], track["extension"]) for track in tracks])
            return True
        except Exception:
            return False


import time
_status_cache = {}

def status():
    now = time.time()
    if "last_check" not in _status_cache or now - _status_cache["last_check"] > 60:
        _status_cache["connected"] = available()
        _status_cache["last_check"] = now
    return {"connected": _status_cache["connected"], "database": MYSQL_CONFIG["database"], "host": MYSQL_CONFIG["host"]}
