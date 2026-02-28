import 'api_client.dart';

class ContactsApi {
  final ApiClient client;

  ContactsApi(this.client);

  Future<void> deleteContact(String contactId) async {
    await client.deleteJson('/v1/contacts/$contactId');
  }
}