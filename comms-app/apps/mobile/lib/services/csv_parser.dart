import 'dart:convert';
import 'package:csv/csv.dart';
import 'package:file_picker/file_picker.dart';

import '../models/contact.dart';

class CsvParser {
  /// Picks a CSV file and parses contacts.
  /// Expected headers (any case): name, phone, email
  /// If no headers found, assumes columns: name, phone, email
  static Future<List<Contact>> pickAndParseCsv() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: const ['csv'],
      withData: true,
    );

    if (result == null || result.files.isEmpty) return [];

    final file = result.files.first;
    final bytes = file.bytes;
    if (bytes == null) return [];

    final raw = utf8.decode(bytes);
    return parseCsv(raw);
  }

  static List<Contact> parseCsv(String csvText) {
    final rows = const CsvToListConverter(
      eol: '\n',
      shouldParseNumbers: false,
    ).convert(csvText);

    if (rows.isEmpty) return [];

    // Determine if first row is a header row
    final firstRow = rows.first.map((e) => (e ?? '').toString().trim()).toList();

    int idxName = -1;
    int idxPhone = -1;
    int idxEmail = -1;

    bool looksLikeHeader = firstRow.any((v) {
      final s = v.toLowerCase();
      return s.contains('name') || s.contains('phone') || s.contains('email');
    });

    int startAt = 0;

    if (looksLikeHeader) {
      startAt = 1;
      for (int i = 0; i < firstRow.length; i++) {
        final h = firstRow[i].toLowerCase();
        if (h == 'name' || h.contains('full name') || h.contains('contact')) idxName = i;
        if (h == 'phone' || h.contains('mobile') || h.contains('number')) idxPhone = i;
        if (h == 'email' || h.contains('e-mail')) idxEmail = i;
      }
    } else {
      // fallback to positional
      idxName = 0;
      idxPhone = firstRow.length > 1 ? 1 : -1;
      idxEmail = firstRow.length > 2 ? 2 : -1;
    }

    final contacts = <Contact>[];

    for (int r = startAt; r < rows.length; r++) {
      final row = rows[r];
      if (row.isEmpty) continue;

      String getAt(int idx) {
        if (idx < 0 || idx >= row.length) return '';
        return (row[idx] ?? '').toString().trim();
      }

      final name = getAt(idxName);
      final phone = getAt(idxPhone);
      final email = getAt(idxEmail);

      if (name.isEmpty && phone.isEmpty && email.isEmpty) continue;
      if (phone.isEmpty && email.isEmpty) continue; // must have at least one route

      contacts.add(
        Contact(
          id: DateTime.now().microsecondsSinceEpoch.toString(),
          name: name.isEmpty ? '(No name)' : name,
          phone: phone.isEmpty ? null : phone,
          email: email.isEmpty ? null : email,
        ),
      );
    }

    return contacts;
  }
}
