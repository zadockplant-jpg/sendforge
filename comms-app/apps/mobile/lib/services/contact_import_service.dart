import '../models/contact.dart';
import '../core/app_state.dart';
import 'api_client.dart';

class ContactImportService {
  final ApiClient api;
  final AppState appState;

  ContactImportService(this.api, this.appState);

  Future<Map<String, dynamic>> importContacts({
    required String method,
    required List<Contact> contacts,
  }) async {
    final payload = {
      'method': method,
      'contacts': contacts
          .map((c) => {
                'name': c.name,
                'phone': c.phone,
                'email': c.email,
              })
          .toList(),
    };

    final response =
        await api.postJson('/v1/contacts/import', payload);

    // 🔹 Immediately refresh contacts from backend
    await appState.loadContacts();

    return response;
  }
}
