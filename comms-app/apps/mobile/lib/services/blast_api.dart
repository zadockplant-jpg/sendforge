import 'api_client.dart';

class BlastsApi {
  final ApiClient _client;
  BlastsApi(this._client);

  Future<Map<String, dynamic>> quote({
    required String userId,
    required List<String> recipients,
    required String body,
  }) async {
    return await _client.postJson('/v1/blasts/quote', {
      'userId': userId,
      'recipients': recipients,
      'body': body,
    });
  }

  Future<Map<String, dynamic>> send({
    required String userId,
    required List<String> recipients,
    required String body,
    required Map<String, dynamic> quote,
  }) async {
    return await _client.postJson('/v1/blasts/send', {
      'userId': userId,
      'recipients': recipients,
      'body': body,
      'quote': quote,
    });
  }
}
