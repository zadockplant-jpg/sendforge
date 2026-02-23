import 'api_client.dart';

class BlastsApi {
  final ApiClient client;
  BlastsApi(this.client);

  /// Quote intl SMS costs (server resolves recipients based on groupIds/contactIds)
  Future<Map<String, dynamic>> quote({
    required List<String> groupIds,
    List<String> contactIds = const [],
    required List<String> channels, // ["sms","email"]
    required String body,
  }) {
    return client.postJson('/v1/blasts/quote', {
      'groupIds': groupIds,
      'contactIds': contactIds,
      'channels': channels,
      'body': body,
    });
  }

  /// Send blast (server resolves recipients based on groupIds/contactIds)
  Future<Map<String, dynamic>> send({
    required List<String> groupIds,
    List<String> contactIds = const [],
    required List<String> channels,
    required String body,
    required Map<String, dynamic> quote,
  }) {
    return client.postJson('/v1/blasts/send', {
      'groupIds': groupIds,
      'contactIds': contactIds,
      'channels': channels,
      'body': body,
      'quote': quote,
    });
  }
}