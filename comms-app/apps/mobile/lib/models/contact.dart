class Contact {
  final String id;
  final String name;
  final String? phone;
   String? get phoneE164 => phone;
  final String? email;
bool get hasSms => phoneE164 != null && phoneE164!.isNotEmpty;
bool get hasEmail => email != null && email!.isNotEmpty;

  Contact({
    required this.id,
    required this.name,
    this.phone,
    this.email,
  });
}
