import React from 'react';
import { View, Text } from 'react-native';

export default function CardScreen() {
  return (
    <View style={{flex:1,alignItems:'center',justifyContent:'center', padding: 16}}>
      <Text style={{fontSize:20,fontWeight:'600', marginBottom: 8}}>Virtual Card</Text>
      <Text style={{backgroundColor:'#ffebee', color: '#c62828', padding: 8, borderRadius: 4, marginBottom: 16, textAlign: 'center'}}>
        🔄 Coming Soon
      </Text>
      <Text style={{textAlign: 'center', color: '#666'}}>Virtual debit card feature coming in the next release</Text>
    </View>
  );
}
