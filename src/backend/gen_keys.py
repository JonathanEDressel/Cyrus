import nacl.signing
import base64

# Generate a new key pair
private_key = nacl.signing.SigningKey.generate()
public_key = private_key.verify_key

# Encode to Base64
private_base64 = base64.b64encode(private_key.encode()).decode()
public_base64 = base64.b64encode(public_key.encode()).decode()

print("\n--- ROBINHOOD API KEYS ---")
print(f"Private Key (Base64): {private_base64}")
print(f"Public Key (Base64):  {public_base64}")
print("---------------------------\n")
