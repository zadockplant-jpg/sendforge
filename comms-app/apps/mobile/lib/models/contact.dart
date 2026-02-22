class Contact {
  final String id;
  final String name;
  final String? phone;
  final String? email;
  final String? organization;

  String? get phoneE164 => phone;

  bool get hasSms => phoneE164 != null && phoneE164!.isNotEmpty;
  bool get hasEmail => email != null && email!.isNotEmpty;

  Contact({
    required this.id,
    required this.name,
    this.phone,
    this.email,
    this.organization,
  });
}