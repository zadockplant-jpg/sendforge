import '../models/contact.dart';
import 'api_client.dart';

class ContactImportService {
  final ApiClient api;

  ContactImportService(this.api);

  Future<Map<String, dynamic>> importContacts({
    required String method,
    required List<Contact> contacts,
  }) async {
    final payload = {
      'method': method,
      'contacts': contacts.map((c) => {
        'name': c.name,
        'phone': c.phone,
        'email': c.email,
      }).toList(),
    };

    return await api.postJson('/v1/contacts/import', payload);
  }
}
