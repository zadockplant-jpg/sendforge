import 'api_client.dart';

class ContactsApi {
  final ApiClient client;

  ContactsApi(this.client);

  Future<List<Map<String, dynamic>>> listContacts() async {
    final resp = await client.getJson('/v1/contacts');
    final list = (resp['contacts'] as List?) ?? [];
    return list.cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> updateContact(
    String contactId, {
    required String name,
    String? organization,
    String? phone,
    String? email,
  }) async {
    final body = <String, dynamic>{
      'name': name,
      'organization': organization,
      'phone': phone,
      'email': email,
    };
    final resp = await client.putJson('/v1/contacts/$contactId', body);
    return resp;
  }

  Future<void> deleteContact(String contactId) async {
    await client.deleteJson('/v1/contacts/$contactId');
  }
}