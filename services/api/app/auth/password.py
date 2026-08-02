"""Password hashing. argon2id, per ARCHITECTURE 7."""

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError

# argon2-cffi defaults to argon2id with parameters tracking the current RFC 9106
# recommendation. Pinning our own numbers here would freeze them at whatever was
# current the day this was written.
_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError):
        return False
    return True


def needs_rehash(password_hash: str) -> bool:
    """True when the hash predates the current cost parameters.

    Called on successful login, which is the only moment the plaintext is available
    to re-hash with.
    """
    return _hasher.check_needs_rehash(password_hash)
